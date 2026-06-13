"""An MCP server exposing x402-paid AceData Cloud tools to any MCP client.

    pip install acedatacloud acedatacloud-x402 mcp
    export X402_PRIVATE_KEY=0x...
    python examples/python/mcp_x402_server.py        # stdio transport

Any MCP-capable agent (Claude Desktop, Claude Code, custom hosts) can now call
`ai_answer` / `generate_image` — each call is paid in USDC on-chain. The host
needs no AceData API key; it only needs this server pointed at a funded wallet.
"""

from mcp.server.fastmcp import FastMCP

from _client import ask, build_client

client = build_client(network="base")
mcp = FastMCP("acedata-x402")


@mcp.tool()
def ai_answer(question: str) -> str:
    """Answer a question with a paid AceData Cloud chat model (USDC per call)."""
    return ask(client, question)


@mcp.tool()
def generate_image(prompt: str) -> str:
    """Generate an image from a prompt and return its URL (paid per call)."""
    task = client.images.generate(provider="nano-banana", prompt=prompt)
    return str(task.wait())


if __name__ == "__main__":
    mcp.run(transport="stdio")
