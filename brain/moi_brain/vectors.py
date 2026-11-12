"""Similarity for items: a 64 bit simhash for near duplicates, and 384 number vectors for "about the same thing".

Vectors come from a local embedding model when one is set up (an OpenAI compatible /embeddings endpoint, such as
Ollama with all-minilm); without one, from feature hashing of words and word pairs, which needs no model and still
puts texts sharing their words close together. Either way they are compared by cosine.
"""

import hashlib
import math
import re
import struct

DIMENSIONS = 384
SIMHASH_BITS = 64
WORD = re.compile(r"[a-z0-9]+")
NEAR_DUPLICATE_BITS = 3
HASHED = "hashed"


def words_of(text: str) -> list[str]:
    return WORD.findall(text.lower())


def token_hash(token: str) -> int:
    return int.from_bytes(hashlib.blake2b(token.encode(), digest_size=8).digest(), "big")


def simhash(text: str) -> int:
    """64 bits that change little when the text changes little: retellings and copies land a few bits apart."""
    tokens = words_of(text)
    shingles = [" ".join(tokens[index : index + 2]) for index in range(len(tokens) - 1)] or tokens
    weights = [0] * SIMHASH_BITS
    for shingle in shingles:
        value = token_hash(shingle)
        for bit in range(SIMHASH_BITS):
            weights[bit] += 1 if value >> bit & 1 else -1
    return sum(1 << bit for bit in range(SIMHASH_BITS) if weights[bit] > 0)


def hamming(first: int, second: int) -> int:
    return (first ^ second).bit_count()


def near_duplicates(first: int, second: int) -> bool:
    return hamming(first, second) <= NEAR_DUPLICATE_BITS


def hashed_vector(text: str) -> list[float]:
    """A unit vector from the text's words and word pairs, each hashed to a dimension with a sign."""
    tokens = words_of(text)
    vector = [0.0] * DIMENSIONS
    for feature in [*tokens, *(f"{tokens[index]} {tokens[index + 1]}" for index in range(len(tokens) - 1))]:
        value = token_hash(feature)
        vector[value % DIMENSIONS] += 1.0 if value >> 63 else -1.0
    return normalized(vector)


def normalized(vector: list[float]) -> list[float]:
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector] if length else vector


def cosine(first: list[float], second: list[float]) -> float:
    """Cosine of two unit vectors (their dot product); vectors of different sizes are not comparable."""
    if len(first) != len(second):
        return 0.0
    return sum(left * right for left, right in zip(first, second, strict=True))


def packed(vector: list[float]) -> bytes:
    return struct.pack(f"{len(vector)}f", *vector)


def unpacked(data: bytes) -> list[float]:
    return list(struct.unpack(f"{len(data) // 4}f", data)) if data and len(data) % 4 == 0 else []
