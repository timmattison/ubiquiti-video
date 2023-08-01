import { PrismaClient } from '@prisma/client'
import { NodeSSH } from 'node-ssh'
import os from 'os'
import net from 'net'
import { UbiquitiEnvironment } from './ubiquiti-environment.ts'

interface PrismaOverSsh {
  prismaClient: any
  ssh: NodeSSH
  localServer: net.Server
}

export async function getPrismaClientOverSsh() {
  const tunnel = await buildTunnelToNvr()

  const result: PrismaOverSsh = {
    prismaClient: new PrismaClient(),
    ssh: tunnel.ssh,
    localServer: tunnel.localServer,
  }

  return result
}

async function buildTunnelToNvr() {
  const ssh = await new NodeSSH().connect({
    privateKeyPath: `${os.homedir()}/.ssh/id_rsa`,
    host: UbiquitiEnvironment.UbiquitiIp,
    username: UbiquitiEnvironment.UbiquitiSshUsername,
  })

  const localServer = net.createServer((localSocket) => {
    ssh
      .forwardOut(
        'localhost',
        0, // Use a random source port
        '127.0.0.1',
        5433 // destination port (remote server)
      )
      .then((remoteSocket) => {
        // Relay traffic between localSocket and remoteSocket
        localSocket.pipe(remoteSocket).pipe(localSocket)

        remoteSocket.on('error', (error: Error) => {
          console.error('Remote socket error:', error)
        })
      })
      .catch((error) => {
        console.error('Error forwarding SSH connection:', error)
      })
  })

  localServer.listen(5433, '0.0.0.0', () => {
    // console.log('Local server listening on 0.0.0.0:5433')
  })

  localServer.on('error', (error) => {
    // console.error('Local server error:', error)
  })

  // Close the local server and SSH connection on exit
  process.on('SIGINT', () => {
    localServer.close()
    ssh.dispose()
    process.exit()
  })

  // Just in case, this tiny sleep here makes sure that the other tasks get a chance to actually run before we return
  await delay(10)

  return { ssh, localServer }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
