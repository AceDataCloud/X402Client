"""A CrewAI tool backed by an x402-paid AceData Cloud call.

    pip install acedatacloud acedatacloud-x402 crewai
    export X402_PRIVATE_KEY=0x...

Hand this tool to any CrewAI agent — each use settles USDC on-chain, so a crew
of agents shares one funded wallet instead of one API key each.
"""

from crewai.tools import BaseTool

from _client import ask, build_client

client = build_client(network="base")


class AceDataAnswerTool(BaseTool):
    name: str = "ace_data_answer"
    description: str = "Answer a question using a paid AceData Cloud chat model (USDC per call)."

    def _run(self, question: str) -> str:
        return ask(client, question)


if __name__ == "__main__":
    tool = AceDataAnswerTool()
    print(tool.run(question="Give one reason agents prefer pay-per-call over API keys."))
