# example.py

import os
import sys
from typing import Optional

def read_file(filepath: str) -> Optional[str]:
    """
    Read content from a file.
    
    Args:
        filepath: Path to the file to read
        
    Returns:
        File content as string if successful, None otherwise
    """
    try:
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"File not found: {filepath}")
        if not os.path.isfile(filepath):
            raise ValueError(f"Not a file: {filepath}")
            
        with open(filepath, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        print(f"Error: File not found: {filepath}")
        return None
    except PermissionError:
        print(f"Error: Permission denied for file: {filepath}")
        return None
    except Exception as e:
        print(f"Error reading file {filepath}: {str(e)}")
        return None

def count_words(text: str) -> int:
    """
    Count the number of words in a text.
    
    Args:
        text: Input text to count words from
        
    Returns:
        Number of words in the text
    """
    if not text:
        return 0
    # Split on any whitespace and remove empty strings
    words = [word for word in text.split() if word.strip()]
    return len(words)

def main():
    """
    Main entry point of the program.
    Reads a file and counts the number of words in it.
    """
    if len(sys.argv) < 2:
        print("Usage: python example.py <filename>")
        print("Where <filename> is the path to the text file to count words from")
        sys.exit(1)

    filepath = sys.argv[1]
    content = read_file(filepath)
    if content:
        num_words = count_words(content)
        print(f"Number of words in {filepath}: {num_words}")
    else:
        print("No content to process.")

if __name__ == "__main__":
    main()
