-- Stage 8 (owner-approved real voices, within the $74 global ceiling): the room's spoken lines and the persona voices
-- designed for them, through gemini-3.8-flash-tts (global location).
--
-- ops.call_limits equals cost_model.LIMITS and arena_core.spend.limits LIMITS:
--   tts           input 14,000 bytes (a 900-character line and a 120-character style at up to 12 escaped bytes a character plus the request
--                 JSON, D11), output 2,000 tokens (80 s of audio at 25 tokens a second; the request's max_output_tokens)
--   voice_design  input 6,000 bytes (a 400-character description plus the request JSON), output 16,384 tokens (the
--                 model's hard output-token limit, since CreateVoice takes no output cap; the voice sample is about
--                 1,100 audio tokens in Google's example)
--
-- ops.model_prices['gemini-3.8-flash-tts'] equals cost_model.LIABILITY_PRICES['3.8-flash-tts']: the list rate from
-- 2027-01-01 ($1.00 per 1M text tokens in, $18.00 per 1M audio tokens out; through 2026-12-31 it is half that), so no
-- reservation falls short when the price rises. text_out prices the output tokens, which for this model are audio
-- (ops.record_usage prices audio output at coalesce(audio_out, text_out)). Both tables are append-only (AR010).
insert into ops.call_limits (call_kind, input_limit, output_limit) values ('tts', 14000, 2000), ('voice_design', 6000, 16384);

insert into ops.model_prices (model, effective_from, text_in, text_out, audio_in, audio_out, source) values
  ('gemini-3.8-flash-tts', '2026-10-12', 1.00, 18.00, null, null,
   'cost_model.py LIABILITY_PRICES (the 2027-01-01 list rate; text_out prices audio output tokens)');
