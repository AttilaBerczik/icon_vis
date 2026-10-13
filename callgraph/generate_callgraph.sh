#!/usr/bin/env bash
#
# Regenerate the call graph DOT files consumed by icon_vis.
#
# Pipeline:
#   1. callgraph/callGraph              (Perl)   -> callgraph.dot
#        Parses the Fortran sources and writes one edge per caller->callee pair,
#        carrying weight=<number of call sites between the two functions>.
#   2. callgraph/add_folders_to_dot.py  (Python) -> callgraph_folders.dot
#        Prefixes every node label with the folder of its source file. This is
#        the file the viewer (index.html) actually loads.
#
# Requirements:
#   - perl with the GraphViz CPAN module   (sudo cpanm GraphViz)
#   - python3
#
# Usage:
#   ./generate_callgraph.sh [options]
#
#   -s, --source DIR   ICON source root         (default: /home/attila/experiment/icon-model/src)
#   -o, --output DIR   Where to write the DOTs  (default: repository root)
#   -r, --recursive    Scan every nested source folder, not just <src>/*/*
#   -h, --help
#
# Without --recursive this mirrors the historical `callGraph ../src/*/*` command,
# i.e. it only picks up files directly inside each first-level source folder.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR="/home/attila/experiment/icon-model/src"
OUTPUT_DIR="$REPO_DIR"
RECURSIVE=0

print_usage() {
    cat <<'EOF'
Regenerate the icon_vis call graph DOT files.

Usage:
  ./generate_callgraph.sh [options]

Options:
  -s, --source DIR   ICON source root         (default: /home/attila/experiment/icon-model/src)
  -o, --output DIR   Where to write the DOTs  (default: repository root)
  -r, --recursive    Scan every nested source folder, not just <src>/*/*
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -s|--source)    SOURCE_DIR="$2"; shift 2 ;;
        -o|--output)    OUTPUT_DIR="$2"; shift 2 ;;
        -r|--recursive) RECURSIVE=1; shift ;;
        -h|--help)      print_usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; print_usage >&2; exit 1 ;;
    esac
done

if [[ ! -d "$SOURCE_DIR" ]]; then
    echo "ERROR: source directory not found: $SOURCE_DIR" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Mirror the historical selection `<src>/*/*` unless --recursive was requested.
if [[ "$RECURSIVE" -eq 1 ]]; then
    mapfile -t FILES < <(find "$SOURCE_DIR" -mindepth 2 -type f | sort)
else
    mapfile -t FILES < <(find "$SOURCE_DIR" -mindepth 2 -maxdepth 2 -type f | sort)
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "ERROR: no source files found under $SOURCE_DIR" >&2
    exit 1
fi

echo "Parsing ${#FILES[@]} source files from $SOURCE_DIR ..."

cd "$OUTPUT_DIR"
perl "$SCRIPT_DIR/callGraph" "${FILES[@]}" -language 'for' -output callgraph.dot
python3 "$SCRIPT_DIR/add_folders_to_dot.py" \
    --source-dir "$SOURCE_DIR" \
    --input callgraph.dot \
    --output callgraph_folders.dot

echo
echo "Wrote:"
echo "  $OUTPUT_DIR/callgraph.dot           (edges carry weight=<call count>)"
echo "  $OUTPUT_DIR/callgraph_folders.dot   (folder-prefixed labels; loaded by the viewer)"
