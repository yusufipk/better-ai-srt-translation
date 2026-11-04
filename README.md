# SRT Translator

Translate `.srt` subtitle files with Gemini (Google AI Studio) or any model on OpenRouter. It runs entirely in your browser, and every translated line stays on its original timestamp.

![SRT Translator](assets/ui.webp)

## Usage

1. Open `index.html` in a browser. There is nothing to install or build.
2. Pick a provider and paste its API key ([Google AI Studio](https://aistudio.google.com/app/apikey) or [OpenRouter](https://openrouter.ai/keys)).
3. Drop an `.srt` file, choose the target language and click Translate.
4. Download the result. Failed chunks keep their original text, so the file is always complete.

The default model is `gemini-3.1-flash-lite` (`google/gemini-3.1-flash-lite` on OpenRouter). Leave Parallel requests at 5 on the Gemini free tier to stay under its rate limit; paid keys can go higher. Rate-limited requests wait out the cooldown Google reports and retry on their own.

## How it keeps timing

Subtitles split sentences across blocks, and languages order words differently, so translating block by block lets text drift into the wrong timestamp. The app tags each block with a marker before sending it:

```
[B1] Hello and welcome to
[B2] a new episode. Today we have
[B3] Chris Titus with us.
```

The model must return the same markers, so each piece of the translation lands back in its own block. Chunks of about 20 blocks are cut at sentence endings and translated in parallel.

Two optional switches change the file before translation: Merge split sentences folds a short trailing fragment into the previous block, and Extend short subtitles lengthens blocks shown for under about 1.3 s. Both are off by default. Arabic and Persian output gets RTL punctuation and bidi markers so players like VLC render it correctly.

## Privacy

Your API key is stored in your browser's `localStorage`. Only subtitle text is sent, and only to the provider you picked.

## License

GPL-3.0
