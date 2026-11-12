"""Signed packs: extractor specs and site policy updates on their own channel, installed only when their Ed25519
signature checks out against the public key that ships with openMoi. A pack never carries code, only data the brain
already validates (specs and policy), and an older pack never replaces a newer one.

    uv run python -m moi_brain.packs keygen <private key file>      prints the public key for policy/pack_key.pub
    uv run python -m moi_brain.packs sign <pack.json> <private key file>   writes pack.json.sig
"""

import base64
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat
from pydantic import BaseModel, Field, ValidationError

from moi_brain.extractors import ExtractorSpec
from moi_brain.files import write_atomic
from moi_brain.policy import PolicyFile

MAX_PACK_BYTES = 2_000_000


class Pack(BaseModel):
    pack_version: int = Field(ge=1)
    created_at: str = ""
    specs: list[ExtractorSpec] = Field(default_factory=list)
    policy: PolicyFile = Field(default_factory=PolicyFile)


class PackError(ValueError):
    """A pack that is too big, unsigned, signed by someone else or not a pack."""


def public_key(path: Path) -> Ed25519PublicKey | None:
    """The key packs must be signed with; None when openMoi ships without one (packs are then off)."""
    try:
        return Ed25519PublicKey.from_public_bytes(base64.b64decode(path.read_text().strip(), validate=True))
    except (OSError, ValueError):
        return None


def verified_pack(data: bytes, signature: bytes, key: Ed25519PublicKey | None) -> Pack:
    """The pack, if the signature over its exact bytes is good; PackError otherwise."""
    if key is None:
        raise PackError("openMoi has no pack key, so packs are off")
    if len(data) > MAX_PACK_BYTES:
        raise PackError("the pack is too big")
    try:
        key.verify(base64.b64decode(signature.strip(), validate=True), data)
    except (InvalidSignature, ValueError) as error:
        raise PackError("the pack's signature does not check out") from error
    try:
        return Pack.model_validate_json(data)
    except ValidationError as error:
        raise PackError(f"the pack is not valid: {error.errors()[0]['msg']}") from error


def installed_pack(packs_dir: Path) -> Pack | None:
    """The pack installed last, checked when it was installed; None when there is none or it is damaged."""
    try:
        return Pack.model_validate_json((packs_dir / "pack.json").read_text())
    except (OSError, ValueError):
        return None


def install(pack: Pack, packs_dir: Path) -> None:
    """The pack's specs replace the last pack's; its policy is read from pack.json."""
    specs_dir = packs_dir / "extractors"
    specs_dir.mkdir(parents=True, exist_ok=True)
    for old in specs_dir.glob("*.json"):
        old.unlink()
    for index, spec in enumerate(pack.specs):
        write_atomic(specs_dir / f"pack_{index}.json", spec.model_dump_json(indent=2))
    write_atomic(packs_dir / "pack.json", pack.model_dump_json(indent=2))


def merged_policy(shipped: PolicyFile, pack: Pack | None) -> PolicyFile:
    """The shipped policy with a pack's sites laid over it: a pack can pause or remove a site (the kill switch)."""
    return shipped if pack is None else PolicyFile(sites={**shipped.sites, **pack.policy.sites})


def keygen(private_path: Path) -> str:
    """A new signing key written to private_path (readable only by you); returns the public key to ship."""
    key = Ed25519PrivateKey.generate()
    write_atomic(private_path, base64.b64encode(key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())).decode(), private=True)
    return base64.b64encode(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def sign(pack_path: Path, private_path: Path) -> Path:
    key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(private_path.read_text().strip()))
    signature_path = pack_path.with_name(f"{pack_path.name}.sig")
    signature_path.write_text(base64.b64encode(key.sign(pack_path.read_bytes())).decode())
    return signature_path


def main(arguments: list[str]) -> int:
    if len(arguments) == 2 and arguments[0] == "keygen":
        print(keygen(Path(arguments[1])))
        return 0
    if len(arguments) == 3 and arguments[0] == "sign":
        print(sign(Path(arguments[1]), Path(arguments[2])))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
