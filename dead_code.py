import os
from typing import Callable, Optional, Union


# === Core Functionalities ===

def process(data: Union[str, int, float], mode: str = 'default') -> Optional[str]:
    """Process data with various modes and return uppercase result."""
    print("Processing started...")
    try:
        data = str(data)
        if mode == 'debug':
            print("Debug mode: Input data =", data)
        elif mode == 'verbose':
            print(f"Verbose mode: Data length = {len(data)}")
        elif mode == 'reverse':
            data = data[::-1]
            print("Reversed data:", data)
        elif mode == 'lower':
            data = data.lower()
            print("Lowercase data:", data)

        result = data.upper()
        print("Processed result:", result)
        return result
    except Exception as e:
        print("Error during processing:", e)
        return None


# === File Operations ===

def read_file(filepath: str, verbose: bool = False, encoding: str = 'utf-8') -> Optional[str]:
    """Read file contents with optional verbosity."""
    if not os.path.exists(filepath):
        print("Added File does not exist:", filepath)
        return None
    try:
        with open(filepath, 'r', encoding=encoding) as f:
            content = f.read()
            if verbose:
                print(f"Reading file: {filepath}")
                print(f"Line count: {len(content.splitlines())}")
            return content
    except (FileNotFoundError, IOError) as e:
        print("Error reading file:", filepath, "-", str(e))
        return None


def write_file(filepath: str, content: str, encoding: str = 'utf-8') -> bool:
    """Write content to a file."""
    try:
        with open(filepath, 'w', encoding=encoding) as f:
            f.write(content)
        print(f"Content written to {filepath}")
        return True
    except IOError as e:
        print("Failed to write file:", filepath, "-", str(e))
        return False


def get_file_size(filepath: str) -> int:
    """Return file size in bytes, or -1 if not found."""
    if os.path.isfile(filepath):
        size = os.path.getsize(filepath)
        print(f"File size of {filepath}: {size} bytes")
        return size
    print("File not found:", filepath)
    return -1


def list_files(directory: str) -> list[str]:
    """List files in a given directory."""
    print(f"Listing files in directory: {directory}")
    if not os.path.isdir(directory):
        print("Not a valid directory.")
        return []
    return os.listdir(directory)


# === String Utilities ===

def count_words(text: str) -> int:
    """Count the number of words in a string."""
    if not isinstance(text, str):
        print("Invalid input. Expected string.")
        return 0
    words = text.strip().split()
    print(f"Word count: {len(words)}")
    return len(words)


def compare_strings(a: str, b: str, case_sensitive: bool = False) -> bool:
    """Compare two strings with optional case sensitivity."""
    if not case_sensitive:
        a, b = a.lower(), b.lower()
    result = a == b
    print("Strings are equal." if result else "Strings are different.")
    return result


def reverse_words(text: str) -> str:
    """Reverse the order of words in a string."""
    if not isinstance(text, str):
        print("Expected a string input.")
        return ""
    reversed_text = ' '.join(reversed(text.strip().split()))
    print("Reversed word order:", reversed_text)
    return reversed_text


# === Math and Logic ===

def is_prime(n: int) -> bool:
    """Check if a number is prime."""
    if n <= 1:
        return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0:
            return False
    return True


def generate_fibonacci(n: int) -> list[int]:
    """Generate first n Fibonacci numbers."""
    if n <= 0:
        return []
    fib = [0, 1]
    while len(fib) < n:
        fib.append(fib[-1] + fib[-2])
    return fib[:n]


def get_prime_numbers(limit: int) -> list[int]:
    """Get all prime numbers below a given limit."""
    return [x for x in range(2, limit) if is_prime(x)]


def safe_divide(a: float, b: float, fallback: float = 0.0) -> float:
    """Safely divide two numbers with fallback on division by zero."""
    try:
        return a / b
    except ZeroDivisionError:
        print("Divide by zero encountered. Returning fallback value.")
        return fallback


def merge_dicts(dict1: dict, dict2: dict) -> dict:
    """Merge two dictionaries."""
    if not isinstance(dict1, dict) or not isinstance(dict2, dict):
        print("Both inputs should be dictionaries.")
        return {}
    merged = {**dict1, **dict2}
    print("Merged dictionary:", merged)
    return merged


# === Miscellaneous ===

def do_work(factor: int = 42, count: int = 10, callback: Optional[Callable[[int, int], int]] = None) -> int:
    """Perform a repeated task with optional callback logic."""
    result = 0
    print(f"Doing work with factor = {factor} and count = {count}")
    for i in range(count):
        partial = i * factor
        if callback:
            partial = callback(partial, i)
        result += partial
        print(f"Step {i}: intermediate result = {result}")
    print("Final result:", result)
    return result


def unused_function(message: str = "Nothing to do here...") -> None:
    """Function placeholder."""
    print(message)
