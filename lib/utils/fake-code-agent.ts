import {Client} from "@modelcontextprotocol/sdk/client/index.js"
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js"
import {ChildProcess} from 'child_process'

export class FakeCodeAgent {
  private client: Client
  private transport: StdioClientTransport

  constructor(command: string, args: string[]) {
    this.transport = new StdioClientTransport({
      command,
      args
    })

    this.client = new Client(
      {name: "fake-code-agent", version: "0.1.0"},
      {}
    )
  }

  async connect() {
    await this.client.connect(this.transport)
  }

  async listTools() {
    return this.client.listTools()
  }

  async callTool(name: string, args: any) {
    return this.client.callTool({name, arguments: args})
  }

  async readResource(uri: string) {
    return this.client.readResource({uri})
  }

  async close() {
    // Get server process reference before closing
    const serverProcess = (this.transport as any)._process as ChildProcess | undefined

    // Close client and transport
    await this.client.close()
    await this.transport.close()

    // Immediately force kill server process to avoid waiting for graceful shutdown
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL')
    }
  }
}
