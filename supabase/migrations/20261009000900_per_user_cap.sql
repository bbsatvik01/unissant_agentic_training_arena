-- 0009 per-user daily spend cap (D-017, owner decision 2026-10-09; S4-D3). ops.config.per_user_daily_usd was seeded
-- at $3.00, below one voice session's whole-session hold (cost_model.VOICE_RESERVATION, $3.392520), so every voice
-- session was refused per user. At $5.00 one voice session fits per user per day with room for text; a second voice
-- session is refused while the first hold is still reserved or usage_unknown ($5.00 - $3.392520 < $3.392520), and fits
-- once the first settles at its actual spend. No other cap, quota or ceiling changes.
-- Gate: supabase/tests/014_budget.sql BU-42.
update ops.config set per_user_daily_usd = 5.00, updated_at = now() where id;
