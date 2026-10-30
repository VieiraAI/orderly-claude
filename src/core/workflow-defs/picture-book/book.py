"""Steps of the picture-book workflow, one subcommand each. Run it from the
project the book is made in; books/ is made there.

    init     write books/<book>/book.json and check the photos are there
    check    measure every page of story.json against the page rules
    sheet    draw a character sheet for the hero, from the photos, and for
             each other character in the story's cast (Higgsfield)
    draw     draw the page art from the sheets and the story (Higgsfield)
    typeset  put each page's text on its art, and make book.pdf
    versions list the versions kept of a book
    restore  put a kept version back (the current one is kept first)

Everything for one book lives in books/<book>/. Each init
first copies the book as it stands into books/<book>/versions/<when>/, so a
new run never loses the last one. A step that
draws skips any picture already drawn from the same prompt, so to redo one,
delete it and run the step again. With images "mock", placeholders are drawn
instead and nothing is sent to Higgsfield.

An optional style folder, such as books/style-guide/, holds reference
pictures of the look. Its style.json says which pictures show finished pages
and which show character sheets; without one, every picture is used for both.
With no style folder, the look comes from the style words alone.
"""
import argparse
import json
import math
import re
import shutil
import subprocess
from datetime import datetime
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageStat

# The project the book is made in: the folder this runs from, not the folder
# the script ships in.
ROOT = Path.cwd().resolve()
BOOKS = ROOT / "books"
CONFIG = json.loads((Path(__file__).parent / "higgsfield.json").read_text())

PPI = 300
BLEED_IN = 0.125
SAFE_IN = 0.375          # inside the trim line, kept clear of text
ZONE_SHARE = 0.28        # the most of the page height the words may take
LINE_SPACING = 1.35
CALM_PAD_IN = 0.3        # calm space asked for around the words, past the text itself
BUSY = 6                 # edge strength behind the words above which a soft wash is added
INK = (43, 38, 34)
PAPER = (251, 246, 236)
FONTS = ["/System/Library/Fonts/Supplemental/Georgia.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
         "C:/Windows/Fonts/georgia.ttf"]
FONT = next((f for f in FONTS if Path(f).exists()), FONTS[0])
PHOTO_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".heic"}
REF_SIDE = 1536          # references are sent at most this big, as JPEG


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def book_dir(name):
    d = (BOOKS / name).resolve()
    if d.parent != BOOKS.resolve():
        fail(f"book name must be a plain folder name, not {name!r}")
    return d


def load(name):
    d = book_dir(name)
    f = d / "book.json"
    if not f.exists():
        fail(f"{f} is missing; the init step makes it")
    return d, json.loads(f.read_text())


def read_json(path, what):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        fail(f"{path} is missing; the {what} step makes it")
    except json.JSONDecodeError as e:
        fail(f"{path} is not valid JSON ({e}); run the {what} step again")


# Page rules ----------------------------------------------------------------

def body_points(age):
    """Type size for a reader of this age; younger readers get bigger type."""
    return 28 if age <= 4 else 24 if age <= 6 else 20


def word_limit(age):
    return 35 if age <= 4 else 60 if age <= 6 else 90 if age <= 8 else 120


def page_px(book):
    return round((book["trim"] + 2 * BLEED_IN) * PPI)


def text_box(book, zone):
    """The box text may use: a band at the top or bottom, inside the safe margin."""
    side = page_px(book)
    margin = round((BLEED_IN + SAFE_IN) * PPI)
    height = round(side * ZONE_SHARE)
    top = margin if zone == "top" else side - margin - height
    return margin, top, side - margin, top + height


def calm_share(book, text, points=None):
    """Share of the page, from the edge, the art should keep calm for these words."""
    fitted = fit(text, book, "top", points)
    lines = len(fitted[1]) * fitted[2] if fitted else text_box(book, "top")[3]
    margin = (BLEED_IN + SAFE_IN) * PPI
    share = (margin + lines + CALM_PAD_IN * PPI) / page_px(book)
    return min(ZONE_SHARE + 0.1, math.ceil(share * 20) / 20)   # up to the next 5%


def font(points):
    px = round(points * PPI / 72)
    try:
        return ImageFont.truetype(FONT, px)
    except OSError:
        return ImageFont.load_default(size=px)


def wrap(text, face, width):
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            trial = f"{line} {word}".strip()
            if face.getlength(trial) <= width or not line:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def fit(text, book, zone, points=None):
    """Largest size from the age's size down to 4 pt smaller that fits the box.
    `points` (largest, smallest) overrides the range, as for a cover title."""
    x0, y0, x1, y1 = text_box(book, zone)
    preferred = body_points(book["age"])
    top, bottom = points or (preferred, preferred - 4)
    for points in range(top, bottom - 1, -1):
        face = font(points)
        lines = wrap(text, face, x1 - x0)
        step = round(face.size * LINE_SPACING)
        widest = max(face.getlength(l) for l in lines)
        if len(lines) * step <= y1 - y0 and widest <= x1 - x0:
            return face, lines, step
    return None


# Steps ---------------------------------------------------------------------

# Versions -------------------------------------------------------------------
# A copy, not a move: the new run then finds pictures whose prompts have not
# changed and does not pay to draw them again.

KEEP_OUT = {"photos", "refs", "versions", ".DS_Store"}


def keep_version(d, why):
    """Copy the book as it stands into versions/<when>/. Returns its name, or None."""
    if not ((d / "story.json").exists() or (d / "pages").exists()):
        return None
    story = {}
    try:
        story = json.loads((d / "story.json").read_text())
    except (OSError, json.JSONDecodeError):
        pass
    when = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    dest = d / "versions" / when
    for item in d.iterdir():
        if item.name in KEEP_OUT:
            continue
        if item.is_dir():
            shutil.copytree(item, dest / item.name)
        else:
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, dest / item.name)
    finished = sorted((d / "pages").glob("[0-9][0-9].png")) if (d / "pages").exists() else []
    (dest / "version.json").write_text(json.dumps({
        "kept": datetime.now().isoformat(timespec="seconds"), "why": why,
        "title": story.get("title"), "pages": len(story.get("pages") or []),
        "finished_pages": len(finished), "pdf": (d / "book.pdf").exists(),
    }, indent=2))
    return when


def versions(a):
    d = book_dir(a.book)
    kept = sorted((d / "versions").glob("*/version.json")) if (d / "versions").exists() else []
    if not kept:
        print(f"No versions kept of {a.book} yet.")
        return
    for f in kept:
        v = json.loads(f.read_text())
        print(f"{f.parent.name}  {v.get('title') or '(no title)'}  ·  {v.get('pages')} pages, "
              f"{v.get('finished_pages')} finished{', book.pdf' if v.get('pdf') else ''}  ·  {v.get('why')}")


def restore(a):
    d = book_dir(a.book)
    src = d / "versions" / a.version
    if not (src / "version.json").exists():
        fail(f"No version {a.version!r}; `book.py versions {a.book}` lists them")
    kept = keep_version(d, f"before restoring {a.version}")
    for item in d.iterdir():
        if item.name not in KEEP_OUT:
            shutil.rmtree(item) if item.is_dir() else item.unlink()
    for item in src.iterdir():
        if item.name == "version.json":
            continue
        (shutil.copytree if item.is_dir() else shutil.copy2)(item, d / item.name)
    print(f"Restored {a.version}." + (f" The book as it was is kept as {kept}." if kept else ""))


def init(a):
    # A field left blank on the run form arrives as "".
    a.pages, a.trim, a.images = a.pages or "16", a.trim or "8.5", a.images or "mock"
    for k in ("title", "name", "age", "style"):
        if not getattr(a, k).strip():
            fail(f"{k} is blank; fill it in on the run form")
    if not (a.age.isdigit() and a.pages.isdigit()):
        fail("age and pages must be whole numbers")
    d = book_dir(a.book)
    kept = keep_version(d, "before a new run")
    if kept:
        print(f"Kept the book as it was in versions/{kept}/.")
    photos = sorted(p for p in (d / "photos").glob("*") if p.suffix.lower() in PHOTO_TYPES)
    if not photos:
        fail(f"Put 1–3 photos of the hero in {d / 'photos'}/ and run again.")
    if len(photos) > 3:
        fail(f"{len(photos)} photos in {d / 'photos'}; use 1–3 clear ones.")
    for p in photos:
        try:
            kind = Image.open(p).format
        except Exception:
            kind = None
        if kind not in ("JPEG", "PNG", "WEBP"):
            fail(f"{p.name} is not a JPEG, PNG or WebP (phone photos are often HEIC). Convert it with:\n"
                 f"  sips -s format jpeg {p} --out {p.with_suffix('.jpg')}\nthen remove the original and run again.")
    if a.images not in ("live", "mock"):
        fail(f'images must be "live" or "mock", not {a.images!r}')
    if a.images == "live":
        if not shutil.which("higgsfield"):
            fail("The Higgsfield CLI is not installed: npm i -g @higgsfield/cli")
        r = subprocess.run(["higgsfield", "account", "status"], capture_output=True, text=True)
        if r.returncode != 0:
            fail(f"Higgsfield is not ready: {(r.stderr or r.stdout).strip()[:300]}\n"
                 "Run `higgsfield auth login`, then `higgsfield workspace set <id>`, or use images mock.")
    # Without a style folder the look comes from the style words alone.
    style_dir = (ROOT / a.style_refs).resolve() if a.style_refs.strip() else None
    if style_dir and (not style_dir.is_dir() or not style_dir.is_relative_to(ROOT)):
        fail(f"style folder {a.style_refs} is not a folder inside the project")
    manifest = style_dir / "style.json" if style_dir else None
    found = sorted(str(f.relative_to(ROOT)) for f in style_dir.iterdir() if f.suffix.lower() in PHOTO_TYPES) if style_dir else []
    refs = json.loads(manifest.read_text()) if manifest and manifest.exists() else {}
    rel = lambda names: [str((style_dir / n).relative_to(ROOT)) for n in names]
    book = {
        "book": a.book, "title": a.title.strip(), "name": a.name.strip(), "age": int(a.age), "pages": int(a.pages),
        "trim": float(a.trim), "style": a.style.strip(), "images": a.images,
        "photos": [str(p.relative_to(ROOT)) for p in photos],
        "page_refs": rel(refs["page_refs"]) if "page_refs" in refs else found,
        "sheet_refs": rel(refs["sheet_refs"]) if "sheet_refs" in refs else found,
    }
    for f in book["page_refs"] + book["sheet_refs"]:
        if not (ROOT / f).exists():
            fail(f"{manifest.relative_to(ROOT)} names {f}, which is not there")
    if not 4 <= book["pages"] <= 40:
        fail("pages must be between 4 and 40")
    (d / "book.json").write_text(json.dumps(book, indent=2))
    side = page_px(book)
    print(f"{book['name']}: {book['pages']} pages for a reader aged {book['age']}, {book['trim']} in square "
          f"({side} px with bleed), {len(photos)} photo(s), images {book['images']}.")
    print(f"Style references: {len(book['page_refs'])} for pages, {len(book['sheet_refs'])} for sheets.")
    print(f"Each page: at most {word_limit(book['age'])} words, set at {body_points(book['age'])} pt.")


def check(a):
    d, book = load(a.book)
    story = read_json(d / "story.json", "story")
    pages = story.get("pages") or []
    problems = []
    if len(pages) != book["pages"]:
        problems.append(f"the story has {len(pages)} pages; the book needs {book['pages']}")
    limit = word_limit(book["age"])
    known = {book["name"].lower()} | {c.get("name", "").lower() for c in story.get("cast") or []}
    for c in story.get("cast") or []:
        if not (c.get("name") and c.get("look")):
            problems.append(f"cast member {c.get('name') or '?'} needs a name and a look")
    for i, p in enumerate(pages, 1):
        for who in p.get("characters") or []:
            if who.lower() not in known:
                problems.append(f"page {i} names {who!r}, who is not the hero or in the cast")
        others = [w for w in p.get("characters") or [] if w.lower() != book["name"].lower()]
        if len(others) > 1:
            problems.append(f"page {i} draws {', '.join(others)}; one cast member besides {book['name']} at most")
        text, zone = (p.get("text") or "").strip(), p.get("text_zone")
        if p.get("page") != i:
            problems.append(f"page {i} is numbered {p.get('page')}")
        if not text:
            problems.append(f"page {i} has no text")
            continue
        if not (p.get("scene") or "").strip():
            problems.append(f"page {i} has no scene to draw")
        if zone not in ("top", "bottom"):
            problems.append(f"page {i}: text_zone must be top or bottom, not {zone!r}")
            continue
        words = len(text.split())
        if words > limit:
            problems.append(f"page {i} has {words} words; the limit at age {book['age']} is {limit}")
        if not fit(text, book, zone):
            problems.append(f"page {i} does not fit its text band at {body_points(book['age']) - 4} pt or larger")
    cover = story.get("cover") or {}
    for k in ("front_scene", "back_scene", "back_text"):
        if not str(cover.get(k) or "").strip():
            problems.append(f"cover.{k} is missing")
    if cover.get("back_text") and not fit(cover["back_text"], book, "top"):
        problems.append("cover.back_text does not fit the back cover")
    if book.get("title") and story.get("title") != book["title"]:
        problems.append(f"the story is titled {story.get('title')!r}; the book is {book['title']!r}")
    if problems:
        fail("The story does not meet the page rules:\n- " + "\n- ".join(problems))
    print(f"All {len(pages)} pages fit: at most {max(len(p['text'].split()) for p in pages)} words a page "
          f"(limit {limit}), every page fits its text band.")


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "character"


def sheet_prompts(book, story, character):
    """One sheet per character: the hero from the photos, the cast from the story."""
    layout = (
        "Character reference sheet for a children's picture book, in exactly "
        + ("the art style of the style reference sheets" if book["sheet_refs"] else "this art style")
        + f": {book['style']}. Cream background with panels: front standing view, face "
        "close-up, three-quarter back view, a sitting pose, and a small colour palette. Same proportions, "
        "colours and clothes in every view. No words, labels, names or lettering anywhere."
    )
    keep = "; ".join(character.get("keep_the_same") or [])
    sheets = {"hero": (
        f"{layout} The character is {book['name']}: {character.get('appearance', '')} "
        f"Outfit: {character.get('outfit', '')}. " + (f"Never change: {keep}. " if keep else "") +
        "Their face must be clearly recognisable as the person in the photo references, drawn in the style."
    )}
    for c in story.get("cast") or []:
        sheets[slug(c["name"])] = f"{layout} The character is {c['name']}: {c['look']}"
    return sheets


def sheet(a):
    d, book = load(a.book)
    story = read_json(d / "story.json", "story")
    character = read_json(d / "character.json", "describe")
    folder = d / "sheet"
    folder.mkdir(exist_ok=True)
    prompts = {k: custom_prompt(folder / f"{k}.png", v) for k, v in sheet_prompts(book, story, character).items()}
    todo = [k for k, prompt in prompts.items() if not drawn(folder / f"{k}.png", prompt)]
    if getattr(a, "only", None):
        todo = [k for k in todo if f"{k}.png" == a.only]
    if not todo:
        print("Every character already has a sheet; delete one in sheet/ to redraw it.")
    else:
        guard_spend(book, len(todo))
    for key in todo:
        out = folder / f"{key}.png"
        if book["images"] == "mock":
            mock_image(out, (2048, 1536), f"SHEET {key}", prompts[key])
        else:
            refs = book["sheet_refs"] + (book["photos"] if key == "hero" else [])
            generate(CONFIG["sheet_model"], prompts[key], refs, out, CONFIG.get("sheet_params", {}), d)
        out.with_suffix(".prompt.txt").write_text(prompts[key])
        print(f"  {key}: sheet/{out.name}", flush=True)
    print(f"{len(prompts)} character sheet(s) in {folder.relative_to(ROOT)}/.")


def draw(a):
    d, book = load(a.book)
    story = read_json(d / "story.json", "story")
    character = read_json(d / "character.json", "describe")
    sheets = d / "sheet"
    names = {c["name"].lower(): slug(c["name"]) for c in story.get("cast") or []}
    names[book["name"].lower()] = "hero"
    for key in set(names.values()):
        if not (sheets / f"{key}.png").exists():
            fail(f"sheet/{key}.png is missing; the sheet step draws it")
    art = d / "art"
    art.mkdir(exist_ok=True)
    keep = "; ".join(character.get("keep_the_same") or [])
    looks = {c["name"].lower(): c["look"] for c in story.get("cast") or []}

    def cast_of(p):
        who = [w for w in (p.get("characters") or []) if w.lower() in names]
        return who or [book["name"]]

    def hero_in(p):
        return any(w.lower() == book["name"].lower() for w in cast_of(p))

    def prompt_for(p):
        refs = ", ".join(f"{w}'s character sheet" for w in cast_of(p))
        return (
            "Full-page illustration for a children's picture book. Match "
            + ("the art style of the style reference pictures exactly" if book["page_refs"] else "the art style of the character sheets exactly")
            + f": {book['style']}. Draw each character exactly as on their sheet "
            f"({refs}). Scene: {p['scene']} "
            + (f"{book['name']}: {character.get('appearance', '')}, wearing {character.get('outfit', '')}. "
               + (f"Never change: {keep}. " if keep else "")
               if hero_in(p) else f"{book['name']} is not in this picture; draw no people. ")
            + "".join(f"{w}: {looks[w.lower()]}. " for w in cast_of(p) if w.lower() in looks)
            + (f'Letter the title "{p["title"]}" across the top in large, warm, hand-drawn storybook '
               "letters that suit the art, clear of every face. Spell it exactly "
               f'"{p["title"]}". No other words, letters or numbers anywhere. Square composition, edge to edge.'
               if p.get("title") else
               f"Keep the {p['text_zone']} {round(calm_share(book, p['text']) * 100)}% of the picture calm "
               "and simple, with no faces or key details, so words can be set there later. Square "
               "composition, edge to edge. "
               "No text, letters, numbers or signs anywhere in the image.")
        )

    # The covers are drawn like pages. The front has its title lettered into
    # the art by a model that letters well; the back keeps room for its lines.
    cover = story.get("cover") or {}
    everyone = [book["name"]] + [c["name"] for c in story.get("cast") or []]
    covers = [
        {"page": "cover-front", "scene": "Front cover of the book: " + cover.get("front_scene", ""),
         "text": "", "title": book.get("title") or story["title"], "text_zone": "top", "characters": everyone},
        {"page": "cover-back", "scene": "Back cover of the book: " + cover.get("back_scene", ""),
         "text": cover.get("back_text", ""), "text_zone": "top", "characters": everyone},
    ]

    name = lambda p: f"{p['page']:02d}.png" if isinstance(p["page"], int) else f"{p['page']}.png"
    prompts = {p["page"]: custom_prompt(art / name(p), prompt_for(p)) for p in story["pages"] + covers}
    if getattr(a, "keep_drawn", False):
        # Keep every picture already drawn, even if its prompt has changed
        # since: only missing ones are drawn.
        for p in story["pages"] + covers:
            if (art / name(p)).exists():
                (art / name(p)).with_suffix(".prompt.txt").write_text(prompts[p["page"]])
    todo = [p for p in story["pages"] + covers if not drawn(art / name(p), prompts[p["page"]])]
    if getattr(a, "only", None):
        todo = [p for p in todo if name(p) == a.only]
    if not todo:
        print("Every page already has art for its scene; delete a page's picture in art/ to redraw it.")
    else:
        guard_spend(book, len(todo))
        side = page_px(book)
        for p in todo:
            out = art / name(p)
            if book["images"] == "mock":
                mock_image(out, (side, side), f"PAGE {p['page']}", p.get("title") or p["scene"], p["text_zone"],
                           0 if p.get("title") else calm_share(book, p["text"]))
            else:
                refs = [str((sheets / f"{names[w.lower()]}.png").relative_to(ROOT)) for w in cast_of(p)]
                model, params = ((CONFIG["cover_model"], CONFIG.get("cover_params", {})) if p.get("title")
                                 else (CONFIG["page_model"], CONFIG.get("page_params", {})))
                generate(model, prompts[p["page"]], book["page_refs"] + refs, out, params, d)
                to_print_size(out, side)
            out.with_suffix(".prompt.txt").write_text(prompts[p["page"]])
            print(f"  {p['page']}: art/{out.name}", flush=True)
    contact_sheet([art / "cover-front.png", *sorted(art.glob("[0-9][0-9].png")), art / "cover-back.png"],
                  art / "contact-sheet.png")
    print(f"{len(story['pages'])} pages of art in {art.relative_to(ROOT)}/; overview in art/contact-sheet.png.")


def custom_prompt(png, made):
    """A prompt someone wrote for one picture by hand wins over the one made from the story."""
    own = png.with_suffix(".prompt.custom.txt")
    return own.read_text() if own.exists() else made


def redraw(a):
    """Draw one picture again from a prompt someone edited.

    The prompt is kept beside the picture as <name>.prompt.custom.txt, so later
    runs of sheet and draw use it too; delete that file to go back to the
    prompt made from the story. The old picture and its prompt move to
    replaced/ in the same folder.
    """
    d, book = load(a.book)
    png = (ROOT / a.picture).resolve()
    if png.parent.parent != d.resolve() or png.parent.name not in ("art", "sheet") or png.suffix != ".png":
        fail(f"{a.picture} is not a picture in books/{a.book}/art/ or books/{a.book}/sheet/")
    prompt = Path(a.prompt_file).read_text().strip()
    if not prompt:
        fail("the prompt is empty")
    if png.exists():
        old = png.parent / "replaced"
        old.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
        png.rename(old / f"{png.stem}-{stamp}.png")
        if png.with_suffix(".prompt.txt").exists():
            png.with_suffix(".prompt.txt").rename(old / f"{png.stem}-{stamp}.prompt.txt")
        print(f"Kept the old picture as {(old / f'{png.stem}-{stamp}.png').relative_to(ROOT)}", flush=True)
    png.with_suffix(".prompt.custom.txt").write_text(prompt)
    a.only = png.name
    (draw if png.parent.name == "art" else sheet)(a)
    if not png.exists():
        fail(f"{png.name} was not drawn")


def drawn(png, prompt):
    saved = png.with_suffix(".prompt.txt")
    return png.exists() and saved.exists() and saved.read_text() == prompt


def typeset(a):
    d, book = load(a.book)
    story = read_json(d / "story.json", "story")
    cover = story.get("cover") or {}
    out_dir = d / "pages"
    out_dir.mkdir(exist_ok=True)
    # The front cover's title is lettered into its art, so it gets no words here.
    jobs = [("cover-front", "", None)]
    jobs += [(f"{p['page']:02d}", p["text"], None) for p in story["pages"]]
    jobs += [("cover-back", cover.get("back_text", ""), None)]
    zones = {f"{p['page']:02d}": p["text_zone"] for p in story["pages"]}
    finished = []
    for stem, text, points in jobs:
        src = d / "art" / f"{stem}.png"
        if not src.exists():
            fail(f"{src.relative_to(ROOT)} is missing; the draw step makes it")
        if text:
            page, note = set_words(src, text, book, zones.get(stem, "top"), points)
        else:
            page, note = Image.open(src).convert("RGB").resize((page_px(book),) * 2, Image.LANCZOS), "title is in the art"
        out = out_dir / f"{stem}.png"
        page.save(out, dpi=(PPI, PPI))
        finished.append(out)
        print(f"  {stem}: {note}", flush=True)
    contact_sheet(finished, out_dir / "contact-sheet.png")
    pdf = d / "book.pdf"
    images = [Image.open(f).convert("RGB") for f in finished]
    images[0].save(pdf, save_all=True, append_images=images[1:], resolution=PPI)
    print(f"Front cover, {len(story['pages'])} pages and back cover in {out_dir.relative_to(ROOT)}/ and "
          f"{pdf.relative_to(ROOT)} ({book['trim'] + 2 * BLEED_IN} in square with bleed, {PPI} ppi).")


# Pictures ------------------------------------------------------------------

def set_words(src, text, book, zone, points=None):
    """Set the words straight on the art, where the picture is calmest.

    The block is only as tall as its lines. It sits at the calmest height
    inside its zone; the ink is dark on light art and light on dark art, with
    a soft glow of the other colour around the letters. Only where the art
    behind is busy does a soft wash go under the words.
    """
    side = page_px(book)
    page = Image.open(src).convert("RGB")
    if page.size != (side, side):
        page = page.resize((side, side), Image.LANCZOS)
    fitted = fit(text, book, zone, points)
    if not fitted:
        fail(f"{src.stem}: the words no longer fit; run the check step")
    face, lines, step = fitted
    x0, z0, x1, z1 = text_box(book, zone)
    height = len(lines) * step
    width = round(max(face.getlength(l) for l in lines))
    left = (side - width) // 2

    # How busy the art is: edge strength, at a quarter size for speed.
    small = page.convert("L").resize((side // 4, side // 4)).filter(ImageFilter.FIND_EDGES)
    def busy(top):
        box = [v // 4 for v in (left, top, left + width, top + height)]
        return ImageStat.Stat(small.crop(box)).mean[0]
    tops = range(z0, max(z0, z1 - height) + 1, 15)
    # Calmest, with a small pull toward the page edge so words do not float.
    edge = z0 if zone == "top" else z1 - height
    top = min(tops, key=lambda t: busy(t) + abs(t - edge) / side * 20)
    score = busy(top)

    box = (left, top, left + width, top + height)
    light = ImageStat.Stat(page.convert("L").crop(box)).mean[0] > 115
    ink, glow = (INK, PAPER) if light else (PAPER, INK)

    pad = round(face.size * 0.6)
    region = (max(0, left - pad), max(0, top - pad), min(side, left + width + pad), min(side, top + height + pad))
    mask = Image.new("L", page.size, 0)
    m = ImageDraw.Draw(mask)
    y = top
    for line in lines:
        m.text((side / 2, y), line, font=face, fill=255, anchor="ma")
        y += step

    if score > BUSY:
        # A soft, rounded wash under the block, fading out at its edges.
        wash = Image.new("L", page.size, 0)
        ImageDraw.Draw(wash).rounded_rectangle(region, radius=pad, fill=150)
        wash = wash.filter(ImageFilter.GaussianBlur(pad * 0.6))
        page = Image.composite(Image.new("RGB", page.size, glow), page, wash)

    crop = mask.crop(region)
    size = max(3, round(face.size * 0.07)) | 1
    halo = crop.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.GaussianBlur(face.size * 0.1))
    halo = halo.point(lambda v: round(v * 0.85))
    full = Image.new("L", page.size, 0)
    full.paste(halo, region[:2])
    page = Image.composite(Image.new("RGB", page.size, glow), page, full)
    page = Image.composite(Image.new("RGB", page.size, ink), page, mask)
    return page, f"{'dark' if light else 'light'} words, {'with a wash, ' if score > BUSY else ''}art behind scores {score:.0f}"


def contact_sheet(files, out, cols=4, thumb=480):
    if not files:
        return
    rows = math.ceil(len(files) / cols)
    gap, label = 24, 44
    sheet_img = Image.new("RGB", (cols * (thumb + gap) + gap, rows * (thumb + label + gap) + gap), (245, 242, 236))
    ink = ImageDraw.Draw(sheet_img)
    face = ImageFont.load_default(size=28)
    for i, f in enumerate(files):
        x = gap + (i % cols) * (thumb + gap)
        y = gap + (i // cols) * (thumb + label + gap)
        im = Image.open(f).convert("RGB")
        im.thumbnail((thumb, thumb))
        sheet_img.paste(im, (x, y))
        caption = f"page {int(f.stem)}" if f.stem.isdigit() else f.stem.replace("-", " ")
        ink.text((x, y + thumb + 8), caption, font=face, fill=INK)
    sheet_img.save(out)


def mock_image(out, size, title, detail, zone=None, calm=0):
    """A stand-in picture, so the workflow can run end to end for free."""
    w, h = size
    seed = sum(map(ord, title + detail))
    base = (150 + seed % 80, 170 + seed * 7 % 60, 160 + seed * 13 % 70)
    im = Image.new("RGB", size, base)
    ink = ImageDraw.Draw(im)
    for r in range(0, max(w, h), 90):
        ink.ellipse([w * 0.6 - r, h * 0.55 - r, w * 0.6 + r, h * 0.55 + r], outline=tuple(c - 25 for c in base), width=6)
    if zone:
        # Mark where the words will go, as a real picture would leave it calm.
        y0 = 0 if zone == "top" else h * (1 - calm)
        ink.rectangle([0, y0, w, y0 + h * calm], fill=tuple(c + 30 for c in base))
    face = ImageFont.load_default(size=max(36, w // 18))
    ink.text((w / 2, h / 2), f"MOCK {title}", font=face, fill=INK, anchor="mm")
    small = ImageFont.load_default(size=max(20, w // 60))
    lines = wrap(detail, small, w * 0.8)[:6]
    for i, line in enumerate(lines):
        ink.text((w / 2, h / 2 + face.size + i * small.size * 1.3), line, font=small, fill=INK, anchor="ma")
    im.save(out)


def to_print_size(path, side):
    im = Image.open(path).convert("RGB")
    if im.size != (side, side):
        w, h = im.size
        s = min(w, h)
        im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((side, side), Image.LANCZOS)
    im.save(path, dpi=(PPI, PPI))


# Higgsfield ---------------------------------------------------------------
# Calls go through the Higgsfield CLI, which uses the browser sign-in
# (`higgsfield auth login`). Every file passed as a reference is uploaded to
# Higgsfield, photos included.

def guard_spend(book, images):
    """Higgsfield spend never reaches Orderly's budget, so cap it here."""
    if book["images"] == "mock":
        return
    cap = CONFIG["max_images_per_run"]
    if images > cap:
        fail(f"{images} pictures to draw is over the cap of {cap} in pipeline/higgsfield.json")
    print(f"Drawing {images} picture(s) on Higgsfield.", flush=True)


def small_ref(path, book_folder):
    """A JPEG copy no bigger than REF_SIDE, so uploads stay quick."""
    src = ROOT / path
    cache = book_folder / "refs"
    cache.mkdir(exist_ok=True)
    out = cache / f"{slug(str(path))}.jpg"
    if not out.exists() or out.stat().st_mtime < src.stat().st_mtime:
        im = Image.open(src).convert("RGB")
        im.thumbnail((REF_SIDE, REF_SIDE))
        im.save(out, quality=90)
    return out


def generate(model, prompt, refs, out, params, book_folder):
    cmd = ["higgsfield", "generate", "create", model, "--prompt", prompt, "--wait", "--wait-timeout", "15m", "--json"]
    for r in refs:
        cmd += [CONFIG["reference_flag"], str(small_ref(r, book_folder))]
    for k, v in params.items():
        cmd += [f"--{k}", str(v)]
    # Higgsfield now and then fails a job without saying why; a second try
    # usually works.
    for attempt in range(1, 4):
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20 * 60)
        if r.returncode == 0:
            break
        print(f"  {out.name}: Higgsfield failed (try {attempt} of 3)", flush=True)
    if r.returncode != 0:
        fail(f"Higgsfield failed on {out.name}: {(r.stderr or r.stdout).strip()[:500]}")
    urls = re.findall(r'https://[^"\s]+?\.(?:png|jpe?g|webp)(?:\?[^"\s]*)?', r.stdout)
    if not urls:
        fail(f"Higgsfield returned no image for {out.name}: {r.stdout.strip()[:500]}")
    with urllib.request.urlopen(urls[0], timeout=120) as resp:
        data = resp.read()
    tmp = out.with_suffix(".download")
    tmp.write_bytes(data)
    Image.open(tmp).convert("RGB").save(out)
    tmp.unlink()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="step", required=True)
    i = sub.add_parser("init")
    i.add_argument("book")
    for flag in ("title", "name", "age", "pages", "trim", "style", "images"):
        i.add_argument(f"--{flag}", required=True)
    i.add_argument("--style-refs", default="")
    for step in ("check", "sheet", "draw", "typeset"):
        sub.add_parser(step).add_argument("book")
    sub.add_parser("versions").add_argument("book")
    r = sub.add_parser("restore")
    r.add_argument("book")
    r.add_argument("version")
    for step in ("sheet", "draw"):
        sub.choices[step].add_argument("--only", help="draw only this picture, such as 10.png")
    rd = sub.add_parser("redraw", help="draw one picture again from an edited prompt")
    rd.add_argument("book")
    rd.add_argument("picture", help="the picture's path in the project, such as books/<book>/art/10.png")
    rd.add_argument("--prompt-file", required=True)
    sub.choices["draw"].add_argument("--keep-drawn", action="store_true",
                                     help="keep pictures already drawn even if their prompt changed")
    a = ap.parse_args()
    {"init": init, "check": check, "sheet": sheet, "draw": draw, "typeset": typeset,
     "versions": versions, "restore": restore, "redraw": redraw}[a.step](a)


if __name__ == "__main__":
    main()
