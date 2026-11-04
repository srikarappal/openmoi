# openMoi

Your own version of the sites you use. A Chromium shell reads X, YouTube and news feeds inside your own sessions, a local brain ranks them with rules you write in plain words and generated lenses show them the way you asked. See [docs/DESIGN.md](docs/DESIGN.md).

## Run

```
cd shell && npm install && npm start
```

The shell starts the brain (`uv run --project brain python -m moi_brain`). Your files live in `~/openMoi/`: `views/*.md` define views, `memory/*.md` is what openMoi knows about you. Models are set in `~/openMoi/.moi/config.json` (both slots default to a local Ollama `llama3`; point `smart` at a hosted model for better lenses and extractors).

Tell the chat panel what you want ("no shorts, hide politics, maya first", "make it a two column magazine") and confirm the diff it proposes, or edit the .md files by hand. On any web tab, press Mine for your own version of that page.

## Test

```
cd brain && uv run pytest              # brain unit and API integration tests
cd shell && npm test                   # shell unit tests
cd shell && npm run test:e2e           # the real app against fake services
```

Both suites use `fixtures/fake_services.py`: fake feeds, YouTube pages, an X style timeline and an OpenAI compatible fake model.
