import {Client} from "@modelcontextprotocol/sdk/client/index.js"
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js"

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
    await this.client.close()
  }
}
