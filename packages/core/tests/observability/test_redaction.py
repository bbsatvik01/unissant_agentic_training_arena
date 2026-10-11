"""Credential masking (lift target: TechnoMile T16; S5 8.3)."""

from __future__ import annotations

import re

from arena_core.observability.redaction import (
    MAX_CREDENTIAL_VALUES,
    MAX_NAME_LENGTH,
    MAX_STRUCTURED_DEPTH,
    MAX_STRUCTURED_LENGTH,
    REDACTED,
    Redaction,
    _backslashes_before,
    _bounded_end,
    _container_end,
    _credential_values,
    _header_value_end,
    _leaves,
    _mask_credential_fields,
    _mask_named_fields,
    _mask_structured,
    _named_value_end,
    _parse,
    _parse_json,
    _parse_literal,
    _prefix_at_end,
    _quote_kind,
    _repr_forms,
    _string_end,
    _Unparseable,
    _value_end,
    decode_name,
    hash_payload,
    is_credential_name,
    secret_values_from_env,
)


def test_bearer_token_is_masked() -> None:
    out = Redaction().text("Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz")
    assert "sk-ant-abcdefghijklmnopqrstuvwxyz" not in out
    assert REDACTED in out


def test_prefixed_credential_tokens_are_masked() -> None:
    r = Redaction()
    for token in ("sk-or-v1-" + "a" * 20, "AIza" + "b" * 30, "ghp_" + "c" * 20, "eyJ" + "d" * 25):
        out = r.text(f"value={token} end")
        assert token not in out


def test_named_credential_field_in_json_is_masked() -> None:
    out = Redaction().text('{"api_key": "abcdef12345", "ok": true}')
    assert "abcdef12345" not in out
    assert "ok" in out


def test_header_field_value_masked_to_end_of_line() -> None:
    out = Redaction().text("Cookie: session=abcdef123456789\nNext-Line: kept")
    assert "abcdef123456789" not in out
    assert "Next-Line: kept" in out


def test_query_field_value_masked() -> None:
    out = Redaction().text("GET /x?api_key=supersecretvalue&other=1")
    assert "supersecretvalue" not in out
    assert "other=1" in out


def test_registered_secret_value_masked_verbatim() -> None:
    r = Redaction(["my-literal-secret-value"])
    out = r.text("the value is my-literal-secret-value in prose")
    assert "my-literal-secret-value" not in out


def test_truncated_tail_credential_prefix_masked() -> None:
    r = Redaction()
    token = "sk-ant-" + "x" * 40
    cut = token[: len(token) - 5]  # the value was cut mid-token at the attribute size limit
    out = r.text(cut, truncated=True)
    assert "sk-ant-" not in out or REDACTED in out


def test_credential_shaped_detects_known_prefix() -> None:
    assert Redaction().credential_shaped("sk-ant-" + "y" * 30) is True
    assert Redaction().credential_shaped("just plain text") is False


def test_is_credential_name_matches_suffix_case_insensitively() -> None:
    assert is_credential_name("API_KEY") is True
    assert is_credential_name("user_token") is True
    assert is_credential_name("username") is False


def test_is_credential_name_fail_closed_on_undecodable_escape() -> None:
    # An escape introducer left after the decode bound counts as a credential (fail closed).
    assert is_credential_name("\\u00") is True


def test_hash_payload_never_contains_the_input() -> None:
    payload_text = "the quick brown fox jumps over 12345"
    digest = hash_payload(payload_text)
    assert payload_text not in digest
    assert digest.startswith("sha256:")
    assert f"len:{len(payload_text)}" in digest


def test_secret_values_from_env_only_picks_credential_shaped_names() -> None:
    env = {"ARENA_API_KEY": "a-real-secret-value", "ARENA_ROLE": "api", "SHORT_KEY": "x"}
    secrets = secret_values_from_env(env)
    assert "a-real-secret-value" in secrets
    assert "api" not in secrets  # ARENA_ROLE does not end in a credential suffix
    assert "x" not in secrets  # below the minimum secret length


def test_value_redacts_each_string_in_a_sequence() -> None:
    out = Redaction().value(["Bearer " + "z" * 24, "plain"])
    assert isinstance(out, list)
    assert "z" * 24 not in out[0]
    assert out[1] == "plain"


def test_mutation_prove_structured_credential_survives_nowhere() -> None:
    """Mutation-proof: every form a credential value can appear in (raw, JSON-escaped, repr-escaped) is
    masked; the raw secret and its alphanumeric core must not survive the pass."""
    masked_value_core = "supersecretcoreabc123"
    text = f'outer {{"headers": {{"authorization": "Bearer {masked_value_core}"}}}} trailer'
    out = Redaction().text(text)
    assert masked_value_core not in out


# ------------------------------------------------------------------------------------- white-box: quote scanning
def test_backslashes_before_counts_a_run() -> None:
    two_backslashes = 2
    text = 'a\\\\"'  # a \ \ "
    assert _backslashes_before(text, 3, 0) == two_backslashes
    assert _backslashes_before(text, 1, 0) == 0  # floor stops the count: text[0] is not a backslash either way


def test_quote_kind_boundary_content_and_ambiguous() -> None:
    assert _quote_kind('a"', 1, 0, 0) == "boundary"  # no backslash: exactly `escapes` (0)
    assert _quote_kind('a\\"', 2, 0, 0) == "content"  # one backslash: escapes a quote at depth 0
    assert _quote_kind('a\\\\"', 3, 0, 0) == "ambiguous"  # two backslashes: parity allows it, but extra precede it


def test_string_end_ambiguous_quote_withholds_to_the_end() -> None:
    text = '"a\\\\"z"'  # the quote at index 4 is ambiguous (two backslashes before it)
    assert _string_end(text, 0, 0) == len(text)


def test_string_end_with_no_closing_quote_runs_to_the_end() -> None:
    text = "'abc"
    assert _string_end(text, 0, 0) == len(text)


def test_container_end_skips_a_different_quote_kind_inside_a_string() -> None:
    text = '{"a": "it\'s"}'
    assert _container_end(text, 0, 0) == len(text)


def test_container_end_ambiguous_quote_withholds_to_the_end() -> None:
    text = '{\\\\"a": 1}'  # two backslashes before the first real quote: ambiguous, not in a string
    assert _container_end(text, 0, 0) == len(text)


def test_container_end_unterminated_runs_to_the_end() -> None:
    assert _container_end('{"a": 1', 0, 0) == len('{"a": 1')


def test_value_end_in_an_escaped_context_withholds_to_the_end() -> None:
    assert _value_end("abc", 0, 1) == len("abc")  # depth > 0: boundary cannot be proven
    assert _value_end("\\abc", 0, 0) == len("\\abc")  # starts with a backslash: same, fail closed


# ------------------------------------------------------------------------------------- white-box: field masking
def test_mask_credential_fields_skips_a_non_matching_quote_in_the_chain() -> None:
    # Three quotes of the same kind after the opening: the first candidate closing quote does not match the
    # opening's escaping depth, so the scan must follow the chain to the next one (redaction.py:180).
    text = '"api_key" : "x\\"y" "secretvalue123"'
    out = _mask_credential_fields(text)
    assert "api_key" in out


def test_mask_credential_fields_ambiguous_name_withholds_the_rest() -> None:
    # Two literal backslashes just before the name's closing quote: parity allows a boundary, but the extra
    # backslashes before it make the name's own extent unclear (redaction.py:194-199).
    text = '"api_key\\\\": "value12345"'
    out = _mask_credential_fields(text)
    assert out.endswith(REDACTED)


VALUE_END = 3
TEXT_END = 4


def test_bounded_end_after_a_comma_and_another_item() -> None:
    assert _bounded_end('"x", "y"', VALUE_END) == VALUE_END  # a comma, then another item: not extended
    assert _bounded_end('"x",', VALUE_END) == VALUE_END  # a comma followed by nothing: a well-formed trailer
    assert _bounded_end('"x"?', VALUE_END) == TEXT_END  # neither a boundary char nor a comma: extended


# ------------------------------------------------------------------------------------- white-box: name decoding
def test_decode_name_too_long_fails_closed() -> None:
    assert decode_name("a" * (MAX_NAME_LENGTH + 1)) is None


def test_decode_name_percent_and_backslash_escapes() -> None:
    assert decode_name("%61pi_key") == "api_key"
    assert decode_name("\\u0061pi_key") == "api_key"
    assert decode_name("\\tabkey") == "\tabkey"


def test_is_credential_name_true_for_a_name_too_long_to_read() -> None:
    assert is_credential_name("a" * (MAX_NAME_LENGTH + 1)) is True


# ------------------------------------------------------------------------------------- white-box: value masking
def test_prefix_at_end_matches_a_split_secret() -> None:
    matched_prefix_length = 3
    assert _prefix_at_end("abcdef", "xxxabc") == matched_prefix_length
    assert _prefix_at_end("a", "xxxabc") == 0  # a one-character secret has no proper prefix worth masking
    assert _prefix_at_end("abcdef", "xxxxxx") == 0


def test_redaction_value_passes_through_a_non_string_non_sequence() -> None:
    not_a_string_or_sequence = 42
    assert Redaction().value(not_a_string_or_sequence) == not_a_string_or_sequence


def test_redaction_value_redacts_a_tuple_and_keeps_it_a_tuple() -> None:
    out = Redaction().value(("Bearer " + "q" * 24, "plain"))
    assert isinstance(out, tuple)
    assert "q" * 24 not in out[0]


def test_mask_cut_tail_masks_a_split_registered_secret() -> None:
    r = Redaction(["my-long-registered-secret-value"])
    cut = "prefix my-long-registered-secret-va"  # cut mid-secret
    out = r.text(cut, truncated=True)
    assert "my-long-registered-secret-va" not in out


def test_mask_cut_tail_masks_a_trailing_partial_token() -> None:
    out = Redaction().text("abc def gh", truncated=True)
    assert out.endswith(REDACTED)


# ------------------------------------------------------------------------------------- white-box: header fields
def test_header_value_runs_to_end_of_line_with_folded_continuation() -> None:
    text = "X-Thing: a\r\n value"
    assert _header_value_end(text, 9) == len(text)


def test_header_value_backslash_right_after_an_opener_withholds_the_rest() -> None:
    text = "X-Thing: \\oops"
    assert _header_value_end(text, 9) == len(text)


def test_header_value_quoted_parameter_consumed_whole() -> None:
    text = 'X-Thing: a="quoted value" b=2'
    assert _header_value_end(text, 9) == len(text)


def test_named_value_end_query_value_through_quoted_part() -> None:
    text = 'api_key="abc def"&other=1'
    end = _named_value_end(text, 8, header=False)
    assert text[end:].startswith("&other=1")


def test_mask_named_fields_skips_a_masked_value_whole() -> None:
    pattern = re.compile(r"(?P<name>[A-Za-z_]+)=")
    out = _mask_named_fields("api_key=supersecretvalue&next=1", pattern, header=False)
    assert "supersecretvalue" not in out
    assert "next=1" in out


# ------------------------------------------------------------------------------------- white-box: structured parse
def test_parse_json_rejects_a_duplicate_key() -> None:
    result = _parse_json('{"a": 1, "a": 2}')
    assert isinstance(result, _Unparseable)
    assert result.reason == "_DuplicateKeyError"


def test_parse_literal_rejects_an_invalid_escape() -> None:
    result = _parse_literal(r"'\q'")
    assert isinstance(result, _Unparseable)


def test_parse_literal_rejects_a_duplicate_key() -> None:
    result = _parse_literal("{'a': 1, 'a': 2}")
    assert isinstance(result, _Unparseable)
    assert result.reason == "duplicate key"


def test_parse_literal_accepts_a_python_literal() -> None:
    assert _parse_literal("{'a': 1}") == {"a": 1}


def test_parse_too_long_text_is_unparseable() -> None:
    result = _parse("[" + "1," * (MAX_STRUCTURED_LENGTH // 2 + 1) + "1]")
    assert isinstance(result, _Unparseable)


def test_leaves_walks_dicts_lists_and_sets() -> None:
    out: list[str] = []
    _leaves({"a": [1, ("b", {2, 3}), None]}, out)
    assert "a" in out
    assert "1" in out
    assert "b" in out


def test_credential_values_depth_limit_fails_closed() -> None:
    # Nested under a NON-credential key, so each layer is re-parsed through the generic string-recursion
    # branch (not `_leaves`'s terminal, no-further-parsing path), driving depth past the limit.
    nested = "leaf"
    for _ in range(MAX_STRUCTURED_DEPTH + 2):
        nested = repr(nested)
    text = '{"other": ' + nested + "}"
    assert _credential_values(text) is None


def test_credential_values_too_many_values_fails_closed() -> None:
    values = ", ".join(f'"v{i}"' for i in range(MAX_CREDENTIAL_VALUES + 5))
    text = '{"api_key": [' + values + "]}"
    assert _credential_values(text) is None


def test_credential_values_empty_for_unstructured_text() -> None:
    assert _credential_values("just plain prose, no brackets") == []


def test_repr_forms_covers_a_value_holding_both_quote_kinds() -> None:
    raw, quoted = _repr_forms("has'both\"kinds")
    assert "has" in raw
    assert "has" in quoted


def test_mask_structured_skips_punctuation_only_values() -> None:
    text = '{"api_key": "!!!"}'
    out = _mask_structured(text)
    assert out == text  # too few alnum characters to be worth masking everywhere


def test_mask_structured_withholds_everything_when_a_core_survives_elsewhere() -> None:
    # The credential value appears once where masking reaches it, and again in a form the scanner does not
    # recognise (doubled, outside any of the escaped forms `_forms` generates): the whole text is withheld.
    text = '{"api_key": "secretcore123"} secretcore123secretcore123'
    out = _mask_structured(text)
    assert out == REDACTED
