"""Site policy: per site how openMoi may read it. "pilot" reads in a reader tab within a daily cap; "assist" reads only the
pages you browse yourself in Chrome; "removed" turns a site off altogether (the kill switch). A Sources line may choose
pilot or assist for its own page; it can never turn a removed site back on."""

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from moi_brain.files import read_json
from moi_brain.items import site_host

Mode = Literal["pilot", "assist"]


class SitePolicy(BaseModel):
    status: Literal["active", "paused", "removed"] = "active"
    mode: Mode = "pilot"
    daily_steps: int = Field(default=200, ge=0, le=1000)
    # Read the JSON the site's pages fetch by themselves (openMoi's own session only), on for sites where it helps.
    capture: bool = False
    # Which actions openMoi may take on the site for you (like, follow, reply, add_to_cart...); all off unless listed.
    writes: dict[str, bool] = Field(default_factory=dict)


class PolicyFile(BaseModel):
    policy_version: int = 1
    sites: dict[str, SitePolicy] = Field(default_factory=dict)


DEFAULT_POLICY = SitePolicy()


def load_policy(path: Path) -> PolicyFile:
    """The built-in policy; a damaged file counts as no policy rather than stopping openMoi."""
    try:
        return PolicyFile.model_validate(read_json(path, {}))
    except ValidationError:
        return PolicyFile()


def policy_for(policies: PolicyFile, url: str) -> SitePolicy:
    """A site's policy, also for its subdomains: m.facebook.com and business.facebook.com follow facebook.com."""
    host = site_host(url)
    labels = host.split(".")
    for start in range(len(labels) - 1):
        found = policies.sites.get(".".join(labels[start:]))
        if found:
            return found
    return DEFAULT_POLICY
