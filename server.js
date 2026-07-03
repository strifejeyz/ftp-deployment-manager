const express = require('express')
const cors = require('cors')
const { exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const ftp = require('basic-ftp')
const SftpClient = require('ssh2-sftp-client')

const app = express()
const PORT = 3000

app.use(cors())
app.use(express.json())

// Serve frontend UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

// Endpoint to fetch config and CWD
app.get('/api/config', (req, res) => {
  const configFile = path.join(process.cwd(), 'deploy-config.json')
  let config = { servers: [], deployments: [] }
  
  if (fs.existsSync(configFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
      // Support old array format or new object format
      if (Array.isArray(data)) {
        config.servers = data
      } else {
        config = { ...config, ...data }
      }
    } catch (e) {
      console.error('Error parsing config:', e.message)
    }
  }
  
  res.json({
    cwd: process.cwd(),
    servers: config.servers || [],
    deployments: config.deployments || []
  })
})

// Endpoint to save configs
app.post('/api/config', (req, res) => {
  const configFile = path.join(process.cwd(), 'deploy-config.json')
  const { servers, deployments } = req.body
  try {
    const data = { servers, deployments }
    fs.writeFileSync(configFile, JSON.stringify(data, null, 2), 'utf-8')
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Helper to scan files recursively (excluding system/dev folders)
function scanDirectory(dir, relativeTo = dir) {
  let items = []
  const list = fs.readdirSync(dir)

  for (const name of list) {
    const fullPath = path.join(dir, name)
    const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/')
    
    // Ignore patterns
    if (
      name === 'node_modules' ||
      name === '.git' ||
      name === 'deploy' ||
      name === 'deploy.exe' ||
      name === 'deploy-config.json' ||
      name === 'deploy-config.example.json'
    ) {
      continue
    }

    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      items.push({
        name: relPath,
        type: 'directory'
      })
      items = items.concat(scanDirectory(fullPath, relativeTo))
    } else {
      items.push({
        name: relPath,
        type: 'file'
      })
    }
  }

  return items
}

// Endpoint to list files in CWD
app.get('/api/files', (req, res) => {
  try {
    const files = scanDirectory(process.cwd())
    res.json({ files })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Endpoint to run deployment and stream logs back to client
app.post('/api/deploy', async (req, res) => {
  // Set headers for SSE-like streaming (chunked transfer encoding)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const log = (text, type = 'info') => {
    res.write(JSON.stringify({ text, type }) + '\n')
  }

  const { hosts, selectedMappings } = req.body
  const configFile = path.join(process.cwd(), 'deploy-config.json')
  
  if (!fs.existsSync(configFile)) {
    log('❌ deploy-config.json not found!', 'error')
    res.end()
    return
  }

  let config = { servers: [] }
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
  } catch (e) {
    log(`❌ Failed parsing deploy-config.json: ${e.message}`, 'error')
    res.end()
    return
  }

  const targetServers = (config.servers || []).filter(s => hosts.includes(s.host))

  if (targetServers.length === 0) {
    log('⚠️  No matching target servers selected.', 'warn')
    res.end()
    return
  }

  if (!selectedMappings || selectedMappings.length === 0) {
    log('⚠️  No deployment mappings selected.', 'warn')
    res.end()
    return
  }

  for (const server of targetServers) {
    log(`----------------------------------------`, 'info')
    const isSFTP = server.protocol === 'sftp' || server.port === 22 || server.port === 2222
    log(`📡 Connecting to ${server.host} via ${isSFTP ? 'SFTP' : 'FTP'}...`, 'info')

    if (isSFTP) {
      const sftp = new SftpClient()
      try {
        await sftp.connect({
          host: server.host,
          port: server.port || 22,
          username: server.user,
          password: server.password,
          readyTimeout: 20000
        })

        log(`✅ Connected successfully to ${server.host}`, 'success')

        for (const mapping of selectedMappings) {
          const localPath = path.join(process.cwd(), mapping.local)
          const remotePath = path.posix.join(server.remotePath, mapping.remote.replace(/\\/g, '/'))
          
          if (!fs.existsSync(localPath)) {
            log(`⚠️  Local path does not exist: ${mapping.local}. Skipping.`, 'warn')
            continue
          }

          if (mapping.type === 'file') {
            log(`📤 Uploading file: ${mapping.local} ➔ ${remotePath}`, 'info')
            const remoteDir = path.posix.dirname(remotePath)
            await sftp.mkdir(remoteDir, true)
            await sftp.put(localPath, remotePath)
          } else if (mapping.type === 'directory') {
            log(`📤 Uploading directory: ${mapping.local} ➔ ${remotePath}`, 'info')
            await sftp.mkdir(remotePath, true)
            await sftp.uploadDir(localPath, remotePath)
          }
        }
        log(`🎉 Finished deploying to ${server.host}!`, 'success')
      } catch (err) {
        log(`❌ SFTP Deployment failed for ${server.host}: ${err.message}`, 'error')
      } finally {
        await sftp.end()
      }
    } else {
      // FTP Mode
      const client = new ftp.Client()
      client.ftp.verbose = false
      try {
        await client.access({
          host: server.host,
          port: server.port || 21,
          user: server.user,
          password: server.password,
          secure: server.secure || false
        })

        log(`✅ Connected successfully to ${server.host}`, 'success')

        for (const mapping of selectedMappings) {
          const localPath = path.join(process.cwd(), mapping.local)
          const remotePath = path.posix.join(server.remotePath, mapping.remote.replace(/\\/g, '/'))

          if (!fs.existsSync(localPath)) {
            log(`⚠️  Local path does not exist: ${mapping.local}. Skipping.`, 'warn')
            continue
          }

          if (mapping.type === 'file') {
            log(`📤 Uploading file: ${mapping.local} ➔ ${remotePath}`, 'info')
            const remoteDir = path.posix.dirname(remotePath)
            await client.ensureDir(remoteDir)
            await client.uploadFrom(localPath, remotePath)
          } else if (mapping.type === 'directory') {
            log(`📤 Uploading directory: ${mapping.local} ➔ ${remotePath}`, 'info')
            await client.ensureDir(remotePath)
            await client.uploadFromDir(localPath, remotePath)
          }
        }
        log(`🎉 Finished deploying to ${server.host}!`, 'success')
      } catch (err) {
        log(`❌ FTP Deployment failed for ${server.host}: ${err.message}`, 'error')
      } finally {
        client.close()
      }
    }
  }

  log(`========================================`, 'info')
  log('🏁 All deployments complete!', 'success')
  res.end()
})

app.listen(PORT, () => {
  console.log(`📡 Local Deploy Server running on http://localhost:${PORT}`)
  exec(`start http://localhost:${PORT}`)
})
