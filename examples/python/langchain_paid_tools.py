"""LangChain tools that call AceData Cloud, paid per call with USDC via x402.

    pip install acedatacloud acedatacloud-x402 langchain-core
    export X402_PRIVATE_KEY=0x...

The agent never sees an API key — each tool invocation is settled on-chain.
"""

from langchain_core.tools import tool

from _client import ask, build_client

client = build_client(network="base")


@tool
def ai_answer(question: str) -> str:
    """Answer a question using a paid AceData Cloud chat model (USDC per call)."""
    return ask(client, question)


@tool
def generate_image(prompt: str) -> str:
    """Generate an image from a prompt and return its URL (paid per call)."""
    task = client.images.generate(provider="nano-banana", prompt=prompt)
    result = task.wait()
    return str(result)


TOOLS = [ai_answer, generate_image]

if __name__ == "__main__":
    # Bind TOOLS to any LangChain agent / LLM that supports tool calling.
    print(ai_answer.invoke({"question": "Name three uses for stablecoin micropayments."}))
