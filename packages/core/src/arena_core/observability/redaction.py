"""Credential masking for every exported string (lift target: TechnoMile T16, `observability/redaction.py:278-362`;
docs/ATTRIBUTIONS.md). Lifted unchanged in substance: this module is already domain-generic (no TechnoMile-specific
names), so nothing here needed renaming for arena.

Every rule runs in linear time on attacker-controlled text (a scraped page or an investigator's free text reaches
a span): regexes start only at a fixed literal or scan maximal runs with possessive quantifiers, and the
credential-prefix scan walks token runs once. A value cut at the span attribute limit also loses its trailing
token, so a credential truncated mid-way cannot survive as a prefix.

Structured text is not left to the lexical scanners alone: a value that parses as JSON or a Python literal (and
any string inside it that does, to a bounded depth) is walked with the real parser, and every value under a
credential-named key is masked wherever it appears in the text (``_mask_structured``). The lexical scanners then
cover prose, truncated values and anything that does not parse.
"""

import ast
import hashlib
import json
import re
from collections.abc import Iterable, Mapping

REDACTED = "[redacted]"

# (prefix, minimum length of prefix + body). Shorter look-alikes ("sk-learn") are ordinary words.
CREDENTIAL_PREFIXES: tuple[tuple[str, int], ...] = (
    ("sk-or-v1-", 24),  # OpenRouter
    ("sk-ant-", 24),  # Anthropic
    ("sk-", 24),  # OpenAI-style and most OpenAI-compatible gateways
    ("AIza", 30),  # Google API key
    ("ya29.", 24),  # Google OAuth access token
    ("eyJ", 24),  # JWT (Supabase anon / service-role keys, OIDC tokens)
    ("gsk_", 24),  # Groq
    ("nvapi-", 24),  # NVIDIA build
    ("csk-", 24),  # Cerebras
    ("ghp_", 24),  # GitHub
    ("gho_", 24),
    ("github_pat_", 24),
    ("xoxb-", 16),  # Slack
    ("xoxp-", 16),
    ("sb_secret_", 16),  # Supabase secret key
)

# Field names whose VALUE is a credential (matched case-insensitively on the name's ending).
CREDENTIAL_NAMES: tuple[str, ...] = (
    "apikey",
    "api_key",
    "api-key",
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "cookie",
    "session_key",
    "private_key",
    "signature",
    "service_role",
    "credentials",
    "dsn",
)

_TOKEN_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.+/=~")
_TOKEN_RUN = re.compile(r"[A-Za-z0-9_\-.+/=~]++")
_AUTH_SCHEME = re.compile(r"(?i)\b(bearer|basic)(\s++)[^\s\"',;]++")
_CREDENTIAL_SUFFIXES = tuple(sorted({w for word in CREDENTIAL_NAMES for w in (word, word.replace("_", ""))}))


# A quote with the backslash run before it (``\\"`` at one escaping depth), matched from the start of the run.
# ``_mask_credential_fields`` reads each one as the possible opening of a quoted field name in JSON, a Python repr
# or serialized JSON at any escaping depth (\"api_key\": ...): the name runs to the next quote of the SAME kind
# that closes at the SAME depth (``_quote_kind``; a quote escaped deeper, like \" in a key, is content), and a
# field head is that name followed by ":" or "=". Every such name is judged DECODED (``is_credential_name``).
_QUOTE_AT_DEPTH = re.compile(r"(?<!\\)(?P<bs>\\*+)(?P<q>[\"'])")
_HEAD_CLOSE = re.compile(r"[\"']\s*+[:=]")
_FIELD_BOUNDARY = frozenset(",}])")
_ITEM_START = frozenset("\"'\\{[}]-0123456789tfnTFN")  # what may follow "," in JSON or a repr
_BARE_END = frozenset(",}]\r\n")


def _backslashes_before(text: str, index: int, floor: int) -> int:
    count = 0
    while index - count - 1 >= floor and text[index - count - 1] == "\\":
        count += 1
    return count


def _quote_kind(text: str, index: int, floor: int, escapes: int) -> str:
    """How a quote at ``index`` reads at a depth whose quotes carry ``escapes`` backslashes (0, 1, 3, 7...).

    "boundary": exactly ``escapes`` backslashes. "content": the run cannot end a string at this depth (escape
    parity; a content backslash is ``2 * (escapes + 1)`` backslashes). "ambiguous": parity allows a boundary but
    extra backslashes precede it (a literal backslash here, or an escape from an embedded repr): the caller then
    masks the rest of the string, fail closed."""
    run = _backslashes_before(text, index, floor)
    if run == escapes:
        return "boundary"
    return "ambiguous" if run % (2 * (escapes + 1)) == escapes else "content"


def _string_end(text: str, j: int, escapes: int) -> int:
    quote = text[j]
    for k in range(j + 1, len(text)):
        if text[k] in "\"'":
            kind = _quote_kind(text, k, j + 1, escapes)
            if kind == "ambiguous":
                return len(text)
            if kind == "boundary" and text[k] == quote:
                return k + 1
    return len(text)


def _container_end(text: str, start: int, depth: int) -> int:
    level, in_string = 0, ""  # the quote that opened the current string, if any
    for k in range(start, len(text)):
        char = text[k]
        if char in "\"'":
            if in_string and char != in_string:
                continue  # the other quote kind inside a string is content
            kind = _quote_kind(text, k, start, depth)
            if kind == "boundary":
                in_string = "" if in_string else char
            elif kind == "ambiguous" or not in_string:
                # outside a string only a boundary quote is well formed: anything else is a quote from another
                # serialization depth (a repr inside JSON) whose structure this scan cannot follow
                return len(text)
        elif not in_string and char in "{[":
            level += 1
        elif not in_string and char in "}]":
            level -= 1
            if level == 0:
                return k + 1
    return len(text)


def _value_end(text: str, start: int, depth: int) -> int:
    """End of the value that starts at ``start``, one linear pass; ``len(text)`` when unterminated or ambiguous:
    a string ends at its own quote at the same escaping, an object or list when balanced (brackets inside strings
    ignored), a bare value at the next delimiter."""
    n = len(text)
    if depth or text.startswith("\\", start):
        # an escaped context (serialized JSON, a repr of a repr): quote escaping differs by serializer, so the
        # boundary cannot be proven; mask the rest of the string (fail closed)
        return n
    if start < n and text[start] in "\"'":
        return _string_end(text, start, 0)
    if start < n and text[start] in "{[":
        return _container_end(text, start, depth)
    k = start
    while k < n and text[k] not in _BARE_END:
        k += 1
    return k


def _mask_credential_fields(text: str) -> str:
    """Mask the value of every quoted field whose decoded name is a credential name. Every quote is tried as an
    opening; its closing is the next quote of the same kind that closes at its escaping depth (``_quote_kind``
    arithmetic on the precomputed backslash runs). After an ordinary quoted stretch the scan resumes just inside
    its opening quote, so nothing a misread stretch covers is skipped."""
    if _HEAD_CLOSE.search(text) is None:
        return text  # no quote is followed by ":" or "=": there is no field head at all
    quotes = [(m.end() - 1, len(m.group("bs"))) for m in _QUOTE_AT_DEPTH.finditer(text)]
    following = [-1] * len(quotes)  # index of the next quote of the same kind
    last = {'"': -1, "'": -1}
    for index in range(len(quotes) - 1, -1, -1):
        kind = text[quotes[index][0]]
        following[index], last[kind] = last[kind], index
    out: list[str] = []
    pos = 0
    n = len(text)
    for index, (opening, depth) in enumerate(quotes):
        if opening < pos:
            continue  # inside a value already masked
        closing, ambiguous = -1, False
        other = following[index]
        while other != -1:
            run = min(quotes[other][1], quotes[other][0] - opening - 1)  # backslashes after the opening only
            if run == depth or run % (2 * (depth + 1)) == depth:
                closing, ambiguous = quotes[other][0], run != depth
                break
            other = following[other]
        if closing < 0:
            continue
        k = closing + 1
        while k < n and text[k] in " \t\r\n":
            k += 1
        if k == n or text[k] not in ":=":
            continue
        k += 1
        while k < n and text[k] in " \t\r\n":
            k += 1
        name = text[opening + 1 : closing - run]
        if not is_credential_name(name):
            continue
        if ambiguous or '"' in name or "'" in name:
            # the name's own extent is unclear (a literal backslash before its closing quote, or a quote inside it,
            # so it may span other fields): everything from its opening quote on is withheld
            out.append(text[pos : opening + 1])
            out.append(REDACTED)
            return "".join(out)
        out.append(text[pos:k])
        out.append(REDACTED)
        pos = _bounded_end(text, max(_value_end(text, k, depth), k))
    out.append(text[pos:])
    return "".join(out)


def _bounded_end(text: str, end: int) -> int:
    """A masked value must be followed by a field boundary: the end of the text, or closing brackets and then the
    end, a further closing bracket or "," and the start of another item (whitespace allowed between). Anything else
    means the value's extent was misread (a quote from another field, a mismatched structure): the rest of the text
    is masked, so no later credential can be skipped."""
    k, n = end, len(text)
    while True:
        while k < n and text[k] in " \t\r\n":
            k += 1
        if k == n:
            return end
        if text[k] == ",":  # a comma must be followed by the start of another item
            k += 1
            while k < n and text[k] in " \t\r\n":
                k += 1
            return end if k == n or text[k] in _ITEM_START else n
        if text[k] not in _FIELD_BOUNDARY:
            return n
        k += 1  # a closing bracket: what follows it must be a boundary too


# name=value in query strings, form bodies and prose (e.g. a scraped "?api_key=..."), and "Name: value" header
# lines. The name is the whole run of name and escape characters before the separator (%61pi_key, api_key),
# taken only from the start of the run (the lookbehind) so each run is read once; it is judged decoded
# (``is_credential_name``). Only the name and separator are matched: a credential's value is then consumed by
# ``_named_value_end`` (a quoted value whole, a header to the end of its line), and an ordinary field's value is
# still scanned for nested fields.
_NAME_RUN = r"(?<![A-Za-z0-9_\-%\\])(?P<name>[A-Za-z0-9_\-%\\]++)"
_QUERY_FIELD = re.compile(_NAME_RUN + r"\s*+=(?!=)\s*+")  # "api_key = value" in prose, any whitespace
_HEADER_FIELD = re.compile(_NAME_RUN + r"[^\S\r\n]*+:[^\S\r\n]*+(?:(?i:bearer|basic)[^\S\r\n]++)?")
_HEADER_OPENERS = frozenset("=:,{[( \t")
_QUERY_END = frozenset(" \t\r\n\f\v&#")  # only what ends a query or form value; other punctuation is value
_ENV_SECRET_NAME = re.compile(r"(?i)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|DSN|DATABASE_URL|CREDENTIALS)$")
_MIN_SECRET_LEN = 8
_MIN_SECRET_TAIL = 4


# A percent escape, or a backslash run with the character it escapes (a, \x61, \t, \/), at any depth.
# An incomplete \u or \x, or a backslash before a percent escape, is left in place for a later round
# (\u005%66 -> _ -> _; \%750061 -> a -> a), never read as a plain character.
_ESCAPED_UNIT = re.compile(r"%[0-9A-Fa-f]{2}|\\++(?:u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|[^\\ux%])")
_UNRESOLVED = re.compile(r"\\|%[0-9A-Fa-f]")  # an escape introducer left after decoding: fail closed
_CONTROL_ESCAPES = {"b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
MAX_NAME_DECODES = 8  # escaping rounds undone on a field name; a name still encoded after them is a credential
MAX_NAME_LENGTH = 512  # a longer field name is not read at all: treated as a credential (fail closed)


def _unescape(match: re.Match[str]) -> str:
    unit = match.group(0)
    if unit.startswith("%"):
        return chr(int(unit[1:], 16))
    escaped = unit.lstrip("\\")
    if escaped[0] in "ux" and len(escaped) > 1:
        return chr(int(escaped[1:], 16))
    return _CONTROL_ESCAPES.get(escaped, escaped)


def decode_name(name: str) -> str | None:
    """A field name with its percent (%61) and backslash (\\u0061, \\t, \\/) escapes undone, repeatedly and in any
    mix (%5Cu0061, \\u0025\\u0036\\u0031, %2561, \\u005%66); None (fail closed) when an escape introducer is left
    after ``MAX_NAME_DECODES`` rounds (a backslash, or a percent sign before a hex digit) or the name is longer than
    ``MAX_NAME_LENGTH``. Each round is one linear pass over a bounded name."""
    if len(name) > MAX_NAME_LENGTH:
        return None
    for _ in range(MAX_NAME_DECODES):
        decoded = _ESCAPED_UNIT.sub(_unescape, name)
        if decoded == name:
            break
        name = decoded
    return None if _UNRESOLVED.search(name) else name


def is_credential_name(name: str) -> bool:
    """Whether a field named ``name`` holds a credential, judged on the DECODED name (fail closed: a name that
    cannot be decoded within the bound counts as a credential)."""
    if "\\" not in name and "%" not in name:  # nothing to decode (the common case)
        return len(name) > MAX_NAME_LENGTH or name.lower().endswith(_CREDENTIAL_SUFFIXES)
    for candidate in (name, name.replace("\\", "")):  # a backslash may be literal or an escape: judge both readings
        decoded = decode_name(candidate)
        if decoded is None or decoded.lower().endswith(_CREDENTIAL_SUFFIXES):
            return True
    return False


def hash_payload(text: str) -> str:
    """A private (subject_private or evaluator) payload as it may appear in a span: its sha256 and length, never
    the text."""
    digest = hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()
    return f"sha256:{digest} len:{len(text)}"


def secret_values_from_env(env: Mapping[str, str]) -> frozenset[str]:
    """Values of credential-named environment variables, masked verbatim wherever they appear."""
    return frozenset(
        value for name, value in env.items() if _ENV_SECRET_NAME.search(name) and len(value) >= _MIN_SECRET_LEN
    )


def _mask_prefixed(token: str) -> str:
    """Mask a credential that starts at a word boundary inside one token run, through the end of the run."""
    for prefix, min_len in CREDENTIAL_PREFIXES:
        start = token.find(prefix)
        while start != -1:
            at_boundary = start == 0 or not token[start - 1].isalnum()
            if at_boundary and len(token) - start >= min_len:
                return token[:start] + REDACTED
            start = token.find(prefix, start + 1)
    return token


class Redaction:
    """Credential redaction for span attribute values, plus exact masking of registered secret values."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self._secrets = tuple(sorted({s for s in secrets if len(s) >= _MIN_SECRET_LEN}, key=len, reverse=True))

    def mask_registered(self, text: str) -> str:
        """Exact replacement of every registered secret VALUE (``secret_values_from_env``) found verbatim in
        ``text`` -- the highest-confidence pass here, an exact match against a known secret, not a pattern.
        Exposed separately so a caller can run it before any OTHER pass that might mutate the text first and
        make the exact match impossible to find afterward (``export_policy.Sanitizer.text()`` does this
        ahead of the PII pass)."""
        for secret in self._secrets:
            text = text.replace(secret, REDACTED)
        return text

    def text(self, text: str, *, truncated: bool = False) -> str:
        text = self.mask_registered(text)
        text = _mask_structured(text)
        text = _AUTH_SCHEME.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)
        text = _mask_credential_fields(text)
        text = _mask_named_fields(text, _QUERY_FIELD, header=False)
        text = _mask_named_fields(text, _HEADER_FIELD, header=True)
        text = _TOKEN_RUN.sub(lambda m: _mask_prefixed(m.group(0)), text)
        if truncated:
            text = self._mask_cut_tail(text)
        return text

    def credential_shaped(self, text: str) -> bool:
        """Whether ``text`` holds a registered secret or a token with a known credential prefix."""
        return any(secret in text for secret in self._secrets) or any(
            _mask_prefixed(run) != run for run in _TOKEN_RUN.findall(text)
        )

    def value(self, value: object, *, truncated: bool = False) -> object:
        if isinstance(value, str):
            return self.text(value, truncated=truncated)
        if isinstance(value, list | tuple):
            items = [self.text(v, truncated=truncated) if isinstance(v, str) else v for v in value]
            return tuple(items) if isinstance(value, tuple) else items
        return value

    def _mask_cut_tail(self, text: str) -> str:
        """The value was cut at the size limit: whatever token it was cut inside may be a credential prefix."""
        for secret in self._secrets:
            size = _prefix_at_end(secret, text)
            if size >= _MIN_SECRET_TAIL:
                text = text[: len(text) - size] + REDACTED
        end = len(text)
        start = end
        while start > 0 and text[start - 1] in _TOKEN_CHARS:
            start -= 1
        if start < end and not text.endswith(REDACTED):
            text = text[:start] + REDACTED
        return text


def _prefix_at_end(secret: str, text: str) -> int:
    """Length of the longest proper prefix of ``secret`` that ``text`` ends with (KMP, linear time)."""
    if not secret[1:]:  # a one-character secret has no proper prefix worth masking
        return 0
    fail = [0] * len(secret)
    k = 0
    for i in range(1, len(secret)):
        while k and secret[i] != secret[k]:
            k = fail[k - 1]
        if secret[i] == secret[k]:
            k += 1
        fail[i] = k
    matched = 0  # the tail is shorter than the secret, so a full match cannot occur
    for char in text[-(len(secret) - 1) :]:
        while matched and char != secret[matched]:
            matched = fail[matched - 1]
        if char == secret[matched]:
            matched += 1
    return matched


def _named_value_end(text: str, start: int, *, header: bool) -> int:
    """End of a credential's value after ``name=`` or ``Name:``. A header value runs to the end of its line (it can
    hold several quoted parameters, as Digest does); a quoted, escaped or bracketed value is consumed whole as in
    JSON (``_value_end``, the rest of the string when unterminated or ambiguous) and the value then runs on to its
    delimiter; a query value ends only at "&", "#" or whitespace (a quote, backslash or comma inside it is part of
    the value)."""
    n = len(text)
    if header:
        return _header_value_end(text, start)
    k = _value_end(text, start, 0) if start < n and text[start] in "\"'\\{[" else start
    while k < n and text[k] not in _QUERY_END:  # through the value's own delimiter, after any quoted part
        k += 1
    return k


def _header_value_end(text: str, start: int) -> int:
    """A header value runs to the end of its line, whatever punctuation it holds, and on through folded
    continuation lines (a line break followed by a space or tab); a quoted value or parameter is consumed whole
    even across lines, and a backslash opening one (escaping that cannot be followed) withholds the rest."""
    n, k = len(text), start
    while k < n:
        if text[k] in "\r\n":
            after = k + 2 if text.startswith("\r\n", k) else k + 1
            if after < n and text[after] in " \t":
                k = after  # a folded continuation belongs to the same field
                continue
            return k
        opens = k == start or text[k - 1] in _HEADER_OPENERS
        if text[k] in "\"'" and opens:
            k = _string_end(text, k, 0)
        elif text[k] == "\\" and opens:
            return n
        else:
            k += 1
    return k


def _mask_named_fields(text: str, pattern: re.Pattern[str], *, header: bool) -> str:
    """``name=value`` or ``Name: value``: the value masked when the decoded name is a credential name. One pass:
    a masked value is skipped whole, an ordinary one is scanned on from just after its separator."""
    out: list[str] = []
    pos = 0
    while (match := pattern.search(text, pos)) is not None:
        out.append(text[pos : match.end()])
        pos = match.end()
        if not is_credential_name(match.group("name")):
            continue
        end = _named_value_end(text, pos, header=header)
        if end > pos:
            out.append(REDACTED)
            pos = end
    out.append(text[pos:])
    return "".join(out)


# ------------------------------------------------------------------------------------ structured credentials
MAX_STRUCTURED_LENGTH = 1_000_000  # longer text is left to the lexical scanners
MAX_STRUCTURED_DEPTH = 6  # serialized JSON or repr inside a string, parsed again up to this depth
MAX_CREDENTIAL_VALUES = 256  # more credential values than this in one text: the whole text is withheld
_MIN_MASKED_VALUE = 4  # values with fewer letters or digits are left to the lexical scanners
_ESCAPE_FORMS = 4
_UNPARSED = object()
_ALNUM_RUN = re.compile(r"[A-Za-z0-9]++")
_INVALID_PY_ESCAPE = re.compile(r"(?<!\\)(?:\\\\)*+\\(?![\\'\"abfnrtvxNuU\n]|[0-3][0-7]{0,2}|[4-7][0-7]?(?![0-7]))")


class _Unparseable:
    """Why structured-looking text could not be parsed safely; the caller withholds the whole text."""

    def __init__(self, reason: str) -> None:
        self.reason = reason


class _DuplicateKeyError(Exception):
    """An object repeats a key: a parser keeps one value and would hide the other."""


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        raise _DuplicateKeyError
    return dict(pairs)


def _parse(text: str) -> object:
    """The value ``text`` serializes, JSON first and then a Python literal. ``_UNPARSED`` when it does not look
    structured (it starts with no bracket or quote); an ``_Unparseable`` when it looks structured but no parser
    accepts it whole, it repeats a key, it is too long, or parsing ran out of depth or memory."""
    stripped = text.strip()
    if not stripped or stripped[0] not in "{[\"'":
        return _UNPARSED
    if len(stripped) > MAX_STRUCTURED_LENGTH:
        return _Unparseable("too long to parse")
    parsed = _parse_json(stripped)
    if isinstance(parsed, _Unparseable) and parsed.reason == "not JSON":
        return _parse_literal(stripped)
    return parsed


def _parse_json(text: str) -> object:
    try:
        return json.loads(text, object_pairs_hook=_unique_pairs)
    except (_DuplicateKeyError, RecursionError) as unsafe:  # a repeated key, or nesting past the parser's depth
        return _Unparseable(type(unsafe).__name__)
    except ValueError as not_json:
        return _Unparseable("not JSON" if isinstance(not_json, json.JSONDecodeError) else str(not_json))


def _parse_literal(text: str) -> object:
    if _INVALID_PY_ESCAPE.search(text):
        return _Unparseable("an invalid escape (never written by repr)")
    try:
        tree = ast.parse(text, mode="eval")
        if any(isinstance(node, ast.Dict) and _repeats_a_key(node) for node in ast.walk(tree)):
            return _Unparseable("duplicate key")
        return ast.literal_eval(tree)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError) as not_literal:
        return _Unparseable(type(not_literal).__name__)


def _repeats_a_key(node: ast.Dict) -> bool:
    """Whether two keys are EQUAL as dictionary keys (1, 1.0 and True are one key), evaluated safely."""
    keys = [ast.literal_eval(key) for key in node.keys if key is not None]
    return len(set(keys)) != len(keys)


def _leaves(value: object, out: list[str]) -> None:
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            stack.extend(item.keys())
            stack.extend(item.values())
        elif isinstance(item, list | tuple | set | frozenset):
            stack.extend(item)
        elif item is not None:
            out.append(item if isinstance(item, str) else str(item))


def _credential_values(text: str) -> list[str] | None:
    """Every scalar under a credential-named key in ``text`` parsed, nested serializations included. None (withhold
    the whole text) when the text or any string inside it looks structured but cannot be parsed safely (see
    ``_parse``), when it is still serialized at ``MAX_STRUCTURED_DEPTH``, or when there are more than
    ``MAX_CREDENTIAL_VALUES`` values. Text with no bracket or quote at all is left to the lexical rules.

    The WHOLE text, AND every nested string value found inside an already-confirmed structure, is read with
    ``_parse`` (not ``_strict``): ordinary prose that merely contains a stray quote or bracket somewhere (an
    apostrophe in "Ask about John's timeline.", a literal bracket in running text) does not even attempt to
    open a literal (``_parse`` returns ``_UNPARSED``) and is left alone, never escalated to a blanket
    redaction, AT ANY NESTING DEPTH -- the lexical passes that follow this one in ``Redaction.text()``
    (``_mask_credential_fields``, ``_mask_named_fields``, the prefix scan) still catch an actual credential
    named field anywhere in such text. A nested string is genuinely ambiguous, and withholds the whole text,
    only when it actually STARTS like a literal (a bracket or quote, same test ``_parse`` itself uses) and
    then fails to parse cleanly -- a stringified credential blob (``"headers": "{\\"Authorization\\": ...}"``)
    still parses through to its leaves exactly as before; only "contains a stray character somewhere" no
    longer counts as looking structured (regression: Codex self-gate round 2, major -- the nested case kept
    the OLD, too-strict interpretation round 1 removed from the top level, so prose one level down, e.g.
    ``{"text": "Ask about John's timeline."}``, was still blanket-redacted)."""
    if not _looks_structured(text):
        return []
    top = _parse(text)
    if top is _UNPARSED:
        return []
    found: list[str] = []
    stack: list[tuple[object, int]] = [(top, 0)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, _Unparseable) or len(found) > MAX_CREDENTIAL_VALUES:
            return None
        if isinstance(item, dict):
            for key, value in item.items():
                if isinstance(key, str) and is_credential_name(key):
                    _leaves(value, found)
                else:
                    stack.append((value, depth))
        elif isinstance(item, list | tuple | set | frozenset):
            stack.extend((element, depth) for element in item)
        elif isinstance(item, str) and _looks_structured(item):
            nested = _parse(item)
            if nested is _UNPARSED:
                continue  # ordinary prose nested inside a confirmed structure, not a serialized sub-value
            if depth >= MAX_STRUCTURED_DEPTH:
                return None  # still serialized at the depth limit: what it holds cannot be judged (fail closed)
            stack.append((nested, depth + 1))
    return None if len(found) > MAX_CREDENTIAL_VALUES else found


def _looks_structured(text: str) -> bool:
    return any(char in text for char in "{[\"'")


def _forms(value: str) -> set[str]:
    """How ``value`` can appear in the text: raw, and escaped by any sequence of JSON and repr serializations up to
    ``_ESCAPE_FORMS`` deep (json inside repr inside json...)."""
    forms = {value, json.dumps(value, ensure_ascii=False)[1:-1]}
    level = {value}
    for _ in range(_ESCAPE_FORMS):
        level = {escaped for form in level for escaped in (json.dumps(form)[1:-1], *_repr_forms(form))}
        forms |= level
    return forms


def _repr_forms(value: str) -> tuple[str, str]:
    """``value`` inside a repr as Python writes it on its own, and inside a single-quoted repr of a longer string
    that also holds a double quote (where "'" is escaped)."""
    return repr(value)[1:-1], repr(value + "'\"")[1:-4]


def _mask_structured(text: str) -> str:
    values = _credential_values(text)
    if values is None:
        return REDACTED
    cores: list[str] = []
    for value in sorted(set(values), key=len, reverse=True):
        if sum(char.isalnum() for char in value) < _MIN_MASKED_VALUE:
            continue  # punctuation-only text: masking it everywhere would break the structure the scanners read
        for form in sorted(_forms(value), key=len, reverse=True):
            if form in text:
                text = text.replace(form, REDACTED)
        cores.extend(run for run in _ALNUM_RUN.findall(value) if len(run) >= _MIN_MASKED_VALUE)
    if any(core in text for core in cores):
        return REDACTED  # a credential's text survives in a form not recognised above: withhold it all
    return text
