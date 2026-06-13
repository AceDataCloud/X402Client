"""OpenAI Agents SDK function tools backed by x402-paid AceData Cloud calls.

    pip install acedatacloud acedatacloud-x402 openai-agents
    export X402_PRIVATE_KEY=0x...

Each function_tool call costs USDC on-chain — no API key is provisioned for the
agent. Point the agent's own model at AceData too by setting its base_url to
https://api.acedata.cloud and reusing the same wallet via the SDK.
"""

import asyncio

from agents import Agent, Runner, function_tool

from _client import ask, build_client

client = build_client(network="base")


@function_tool
def ai_answer(question: str) -> str:
    """Answer a question with a paid AceData Cloud chat model (USDC per call)."""
    return ask(client, question)


agent = Agent(
    name="x402-research-agent",
    instructions="Use the ai_answer tool to research questions. Be concise.",
    tools=[ai_answer],
)


async def main() -> None:
    result = await Runner.run(agent, "What is the x402 payment protocol, in two sentences?")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
