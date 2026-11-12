"""Shop: your words searched in each store a view names, the products ranked by your model like any item, and a price
history kept from the prices you actually saw, so a card can say when this is the lowest you have seen."""

import re
from datetime import datetime
from urllib.parse import quote_plus, urlparse

from pydantic import BaseModel, Field

from moi_brain.compile import QUERY_SLOT
from moi_brain.items import Item

PRICE = re.compile(r"(?P<symbol>[$€£¥₹])\s?(?P<amount>\d[\d,]*(?:\.\d{1,2})?)|(?P<plain>\d[\d,]*(?:\.\d{1,2})?)\s?(?P<code>USD|EUR|GBP|INR|JPY)\b")
CODES = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥"}
ASIN_PATH = re.compile(r"/(?:dp|gp/product)/([A-Z0-9]{10})")
MAX_QUERY = 200


class Price(BaseModel):
    amount: float
    symbol: str

    def text(self) -> str:
        return f"{self.symbol}{self.amount:,.2f}"


class ShopState(BaseModel):
    """What each view last shopped for."""

    queries: dict[str, str] = Field(default_factory=dict)


def parse_price(text: str) -> Price | None:
    """The first price in a text such as "$1,299.00" or "24.99 EUR"; None when there is none."""
    match = PRICE.search(text or "")
    if not match:
        return None
    amount = match.group("amount") or match.group("plain")
    symbol = match.group("symbol") or CODES[match.group("code")]
    return Price(amount=float(amount.replace(",", "")), symbol=symbol)


def search_urls(stores: list[str], query: str) -> list[str]:
    """Each store's search address with your words in it."""
    words = quote_plus(query.strip()[:MAX_QUERY])
    return [store.replace(QUERY_SLOT, words) for store in stores] if words else []


def shop_source_id(url: str) -> str:
    """A store's search for one query: the query is part of it, so a new search starts from nothing."""
    parsed = urlparse(url)
    return f"shop:{(parsed.hostname or 'store').removeprefix('www.')}{parsed.path.rstrip('/')}?{parsed.query}"


def product_key(item: Item) -> str:
    """One product however a store links it: an Amazon product by its ASIN, anything else by its address without the
    query and fragment."""
    parsed = urlparse(item.url)
    asin = ASIN_PATH.search(parsed.path)
    if asin:
        return f"asin:{asin.group(1)}"
    return f"{parsed.netloc}{parsed.path}".lower()


def price_note(current: Price, history: list[tuple[float, datetime]]) -> str:
    """What the prices you saw before say about this one: the lowest you saw and when, or that this is the lowest."""
    days = {seen_at.date() for _, seen_at in history}
    if len(days) < 2:
        return ""
    low, low_at = min(history)
    if current.amount <= low:
        return f"The lowest you have seen since {min(days):%b %-d}"
    return f"Lowest you saw: {Price(amount=low, symbol=current.symbol).text()} on {low_at:%b %-d}"
