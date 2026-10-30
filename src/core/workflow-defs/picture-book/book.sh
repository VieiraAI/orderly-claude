#!/bin/sh
# Run book.py with a Python that has Pillow: the project's .venv if it has
# one, otherwise python3 on the PATH.
here=$(dirname "$0")
for py in .venv/bin/python python3; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import PIL' 2>/dev/null; then
    exec "$py" "$here/book.py" "$@"
  fi
done
echo "Error: the picture-book workflow needs Python 3 with Pillow. Install it with: python3 -m pip install pillow" >&2
exit 1
