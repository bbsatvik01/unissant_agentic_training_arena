"""The 30 prebuilt Gemini TTS voices (stage 5), in a module of their own so the catalogue and the service share them."""

from __future__ import annotations

#: The 30 prebuilt voices (Vertex AI "Generate speech with Gemini TTS", checked 2026-10-11): the only names a line
#: may ask for.
PREBUILT_VOICES = frozenset(
    {
        "Achernar",
        "Achird",
        "Algenib",
        "Algieba",
        "Alnilam",
        "Aoede",
        "Autonoe",
        "Callirrhoe",
        "Charon",
        "Despina",
        "Enceladus",
        "Erinome",
        "Fenrir",
        "Gacrux",
        "Iapetus",
        "Kore",
        "Laomedeia",
        "Leda",
        "Orus",
        "Puck",
        "Pulcherrima",
        "Rasalgethi",
        "Sadachbia",
        "Sadaltager",
        "Schedar",
        "Sulafat",
        "Umbriel",
        "Vindemiatrix",
        "Zephyr",
        "Zubenelgenubi",
    }
)
