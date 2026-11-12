"""Shop: your words searched in each store a view names, the products ranked by your model like any item, and a price
history kept from the prices you actually saw, so a card can say when this is the lowest you have seen."""

import re
from datetime import datetime
from urllib.parse import quote_plus, unquote, urlparse

from pydantic import BaseModel, Field

from moi_brain.compile import QUERY_SLOT
from moi_brain.items import Item

PRICE = re.compile(r"(?P<symbol>[$€£¥₹])\s?(?P<amount>\d[\d.,]*\d|\d)|(?P<plain>\d[\d.,]*\d|\d)\s?(?P<code>USD|EUR|GBP|INR|JPY)\b")
# A price for one unit ("$0.54/count", "€2 per kg") is not the product's price.
PER_UNIT = re.compile(r"^\s*(?:/|per\b)", re.IGNORECASE)
CODES = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹", "JPY": "¥"}
ASIN_PATH = re.compile(r"/(?:dp|gp/product)/([A-Z0-9]{10})(?![A-Z0-9])")
MAX_QUERY = 200


class Price(BaseModel):
    amount: float
    symbol: str

    def text(self) -> str:
        return f"{self.symbol}{self.amount:,.2f}"


class ShopState(BaseModel):
    """What each view last shopped for."""

    queries: dict[str, str] = Field(default_factory=dict)


def plain_amount(written: str) -> float | None:
    """A written amount as a number, in either convention: "1,299.00" and "1.299,00" are both 1299, "24,99" is 24.99
    and "1.299" is 1299 (three digits after one kind of separator group thousands; one or two are cents)."""
    separators = [position for position, character in enumerate(written) if character in ".,"]
    if not separators:
        return float(written)
    last = separators[-1]
    decimals = len(written) - last - 1
    if decimals == 3 and len({written[position] for position in separators}) == 1:
        return float(written.replace(".", "").replace(",", ""))
    if decimals in (1, 2):
        return float(f"{written[:last].replace('.', '').replace(',', '')}.{written[last + 1 :]}")
    return None


def parse_price(text: str) -> Price | None:
    """The first price in a text such as "$1,299.00", "€ 24,99" or "24.99 EUR", skipping prices per unit; None when
    there is none."""
    for match in PRICE.finditer(text or ""):
        if PER_UNIT.match(text[match.end() :]):
            continue
        amount = plain_amount(match.group("amount") or match.group("plain"))
        if amount is not None:
            return Price(amount=amount, symbol=match.group("symbol") or CODES[match.group("code")])
    return None


def search_urls(stores: list[str], query: str) -> list[str]:
    """Each store's search address with your words in it."""
    words = quote_plus(query.strip()[:MAX_QUERY])
    return [store.replace(QUERY_SLOT, words) for store in stores] if words else []


def shop_source_id(url: str) -> str:
    """A store's search for one query: the query is part of it, so a new search starts from nothing."""
    parsed = urlparse(url)
    return f"shop:{(parsed.hostname or 'store').removeprefix('www.')}{parsed.path.rstrip('/')}?{parsed.query}"


def product_key(item: Item) -> str:
    """One product in one store however the store links it: an Amazon product by its store and ASIN (found inside a
    sponsored link too), anything else by its address without the query and fragment."""
    parsed = urlparse(item.url)
    host = (parsed.hostname or "").removeprefix("www.")
    asin = ASIN_PATH.search(unquote(unquote(item.url)))
    if asin:
        return f"asin:{host}:{asin.group(1)}"
    return f"{host}{parsed.path}".lower()


def price_note(current: Price, history: list[tuple[float, str, datetime]]) -> str:
    """What the prices you saw before, in the same currency, say about this one: the lowest you saw and when, or that
    this is the lowest."""
    history = [(amount, seen_at) for amount, symbol, seen_at in history if symbol == current.symbol]
    days = {seen_at.date() for _, seen_at in history}
    if len(days) < 2:
        return ""
    low, low_at = min(history)
    if current.amount <= low:
        return f"The lowest you have seen since {min(days):%b %-d}"
    return f"Lowest you saw: {Price(amount=low, symbol=current.symbol).text()} on {low_at:%b %-d}"
