# example.py

import os
import sys

def read_file(filepath):
    try:
        with open(filepath, 'r') as f:
            return f.read()
    except:
        print("Could not read file:", filepath)
        return None

def count_words(text):
    words = text.split(" ")
    return len(words)

def main():
    if len(sys.argv) < 2:
        print("Usage: python example.py <filename>")
        sys.exit(1)

    filepath = sys.argv[1]
    content = read_file(filepath)
    if content:
        num_words = count_words(content)
        print("Number of words:", num_words)
    else:
        print("No content to process.")

main()
