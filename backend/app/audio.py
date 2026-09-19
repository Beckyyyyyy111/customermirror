import io

from openai import AsyncOpenAI

from . import config

client = AsyncOpenAI(api_key=config.OPENAI_API_KEY)


async def transcribe(audio_bytes: bytes, filename: str = "audio.webm") -> str:
    buffer = io.BytesIO(audio_bytes)
    buffer.name = filename
    response = await client.audio.transcriptions.create(
        model=config.STT_MODEL,
        file=buffer,
    )
    return response.text


async def synthesize(text: str, voice: str = "alloy") -> bytes:
    response = await client.audio.speech.create(
        model=config.TTS_MODEL,
        voice=voice,
        input=text,
        response_format="mp3",
    )
    return response.read()
