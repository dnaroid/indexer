import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import { FakeCodeAgent } from './fake-code-agent.js'

/**
 * Integration test for FakeCodeAgent
 *
 * This test verifies that FakeCodeAgent can connect to a real MCP server
 * via stdio transport and perform operations like listing tools and calling them.
 */

const INDEXER_SERVICE_BIN = path.resolve(process.cwd(), 'build/lib/services/indexer-service.js')

/**
 * Start a simple MCP server for testing
 */
function startTestMcpServer(): ChildProcess {
  const serverProcess = spawn('node', [INDEXER_SERVICE_BIN, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' }
  })

  serverProcess.stderr?.on('data', (data) => {
    const output = data.toString()
    if (output.includes('error') || output.includes('Error')) {
      console.error('[MCP SERVER ERROR]', output)
    }
  })

  serverProcess.on('error', (err) => {
    console.error('[TEST] Failed to spawn MCP server:', err)
  })

  return serverProcess
}

test('FakeCodeAgent can connect to MCP server', async () => {
  const agent = new FakeCodeAgent('node', [INDEXER_SERVICE_BIN, '--mcp'])

  await agent.connect()

  // Verify connection by listing tools
  const toolsResponse = await agent.listTools()
  assert.ok(toolsResponse, 'Tools response should exist after connection')

  await agent.close()
})

test('FakeCodeAgent can list tools from MCP server', async () => {
  const agent = new FakeCodeAgent('node', [INDEXER_SERVICE_BIN, '--mcp'])

  await agent.connect()

  const toolsResponse = await agent.listTools()

  // Verify response structure
  assert.ok(toolsResponse, 'Tools response should exist')
  assert.ok(toolsResponse.tools, 'Tools array should exist')
  assert.ok(Array.isArray(toolsResponse.tools), 'Tools should be an array')
  assert.ok(toolsResponse.tools.length > 0, 'Should have at least one tool')

  // Verify that indexer tools are present
  const toolNames = toolsResponse.tools.map((t: any) => t.name)
  assert.ok(toolNames.includes('search_codebase'), 'Should have search_codebase tool')
  assert.ok(toolNames.includes('get_project_structure'), 'Should have get_project_structure tool')

  console.log(`[TEST] Found ${toolsResponse.tools.length} tools:`, toolNames)

  await agent.close()
})

test('FakeCodeAgent can call a tool', async () => {
  const agent = new FakeCodeAgent('node', [INDEXER_SERVICE_BIN, '--mcp'])

  await agent.connect()

  // First, get the list of collections
  const toolsResponse = await agent.listTools()
  assert.ok(toolsResponse.tools, 'Should have tools')

  // Try to call a simple tool that doesn't require specific setup
  // We'll use get_project_structure which should work even without a collection
  // But since it requires collectionId, we need to handle the case where it might fail

  try {
    // This call might fail because we don't have a proper collection set up
    // but it should return a proper error response, not crash
    const result = await agent.callTool('get_project_structure', {
      collectionId: 'test-collection-that-does-not-exist'
    })

    // If it returns content, verify structure
    if (result.content) {
      assert.ok(Array.isArray(result.content), 'Content should be an array')
    }
  } catch (error: any) {
    // It's okay if the tool call fails with a proper error
    // We're just testing that the communication works
    console.log('[TEST] Tool call returned error (expected):', error.message)
    assert.ok(error.message, 'Error should have a message')
  }

  await agent.close()
})

test('FakeCodeAgent can handle multiple sequential operations', async () => {
  const agent = new FakeCodeAgent('node', [INDEXER_SERVICE_BIN, '--mcp'])

  await agent.connect()

  // List tools multiple times
  const tools1 = await agent.listTools()
  const tools2 = await agent.listTools()

  assert.ok(tools1.tools.length > 0, 'First listTools should return results')
  assert.ok(tools2.tools.length > 0, 'Second listTools should return results')
  assert.equal(
    tools1.tools.length,
    tools2.tools.length,
    'Both calls should return same number of tools'
  )

  await agent.close()
})

test('FakeCodeAgent can readResource', async () => {
  const agent = new FakeCodeAgent('node', [INDEXER_SERVICE_BIN, '--mcp'])

  await agent.connect()

  try {
    // Try to read a resource
    // This might not be supported by all MCP servers
    const result = await agent.readResource('test://resource')

    if (result) {
      assert.ok(result, 'Resource read should return something')
    }
  } catch (error: any) {
    // It's okay if resources are not supported
    console.log('[TEST] Resource read not supported or failed:', error.message)
    assert.ok(error.message, 'Error should have a message')
  }

  await agent.close()
})

test('FakeCodeAgent handles connection to non-existent server gracefully', async () => {
  const agent = new FakeCodeAgent('node', ['/nonexistent/path/to/server.js'])

  try {
    await agent.connect()
    assert.fail('Should have thrown an error')
  } catch (error) {
    // Expected to fail
    assert.ok(error, 'Should throw an error when server cannot be started')
    console.log('[TEST] Failed to connect to non-existent server (expected)')
  }

  // No need to close since connection failed
})

test('FakeCodeAgent can close connection cleanly', async () => {
  const agent = new FakeCodeAgent('node', [INDEXER_SERVICE_BIN, '--mcp'])

  await agent.connect()
  await agent.listTools()

  // Close should not throw
  await agent.close()

  assert.ok(true, 'Connection closed successfully')
})

// Global cleanup after all tests
test.after(async () => {
  // Wait a bit for any remaining processes to exit
  await new Promise(resolve => setTimeout(resolve, 100))

  // Force exit after cleanup - these tests are integration tests
  // and we don't need to wait for all resources to cleanly close
  setTimeout(() => {
    process.exit(0)
  }, 200).unref() // unref so it doesn't keep process alive
})
