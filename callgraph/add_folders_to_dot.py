#!/usr/bin/env python3
"""
Prefix every function node label in a callGraph .dot file with the folder of
its source file, producing the "folder" .dot that icon_vis loads.

The incoming .dot (produced by ./callGraph) has node labels of the form:

    label="mo_advection_traj.f90\\nconstruct"

This script scans the source tree to learn which folder each file lives in and
rewrites the label to:

    label="advection\\nmo_advection_traj.f90\\nconstruct"

Only node labels are touched. Edge attributes, including the numeric
`weight=<call count>` emitted by ./callGraph, are passed through unchanged.

Usage:
    python3 add_folders_to_dot.py \
        --source-dir /path/to/icon/src \
        --input callgraph.dot \
        --output callgraph_folders.dot
"""
import argparse
import os
import re


def map_files_to_folders(source_dir):
    """Scans the source directory and maps filenames to their relative folder paths."""
    print(f"Scanning source directory: {source_dir}...")
    file_to_folder = {}
    for root, _, files in os.walk(source_dir):
        for file in files:
            # Get the relative path of the folder
            relative_folder = os.path.relpath(root, source_dir)
            # Ensure we don't just get '.' for the root directory
            if relative_folder == ".":
                relative_folder = "root"
            file_to_folder[file] = relative_folder
    return file_to_folder


def update_dot_labels(dot_filepath, source_dir, output_filepath):
    # 1. Build the mapping dictionary
    file_to_folder = map_files_to_folders(source_dir)

    # 2. Read the original .dot file
    print(f"Reading DOT file: {dot_filepath}...")
    try:
        with open(dot_filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        print(f"Error: Could not find '{dot_filepath}'. Please check the path.")
        return

    # 3. Define a regex function to replace the label
    def label_replacer(match):
        original_label = match.group(1)

        # In .dot files, newlines in labels are usually written as literal \n
        parts = original_label.split(r"\n")

        if len(parts) >= 1:
            file_name = parts[0]

            # Skip the default node template label, and any purely numeric label
            # (defensive: we never want to prefix an edge's count label).
            if file_name == r"\N" or re.fullmatch(r"-?\d+(?:\.\d+)?", file_name):
                return match.group(0)

            # Try to find the folder, default to 'Unknown_Folder'
            folder_name = file_to_folder.get(file_name, "Unknown_Folder")

            # Construct the new label: folder\nfilename\nfunction
            new_label = rf"{folder_name}\n" + original_label
            return f'label="{new_label}"'

        return match.group(0)

    # 4. Apply the regex substitution
    # Matches label="<anything inside quotes>"
    updated_content = re.sub(r'label="([^"]+)"', label_replacer, content)

    # 5. Write the updated .dot file
    print(f"Exporting updated DOT file to: {output_filepath}...")
    with open(output_filepath, "w", encoding="utf-8") as f:
        f.write(updated_content)
    print("Done!")


def main():
    parser = argparse.ArgumentParser(
        description="Prefix callGraph .dot node labels with their source folder."
    )
    parser.add_argument(
        "--source-dir",
        default="/home/attila/experiment/icon-model/src",
        help="Root folder of the ICON source tree (default: %(default)s)",
    )
    parser.add_argument(
        "--input",
        default="callgraph.dot",
        help="Input .dot file produced by ./callGraph (default: %(default)s)",
    )
    parser.add_argument(
        "--output",
        default="callgraph_folders.dot",
        help="Output .dot file with folder-prefixed labels (default: %(default)s)",
    )
    args = parser.parse_args()

    update_dot_labels(args.input, args.source_dir, args.output)


if __name__ == "__main__":
    main()
