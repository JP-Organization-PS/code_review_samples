import os

def process(data, mode='default'):
    print("Processing started...")
    try:
        if not isinstance(data, str):
            data = str(data)

        if mode == 'debug':
            print("Debugging... Input data:", data)
        elif mode == 'verbose':
            print(f"Verbose mode: data length = {len(data)}")
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


def read_file(filepath, verbose=False, encoding='utf-8'):
    if not os.path.exists(filepath):
        print("File does not exist:", filepath)
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


def write_file(filepath, content, encoding='utf-8'):
    try:
        with open(filepath, 'w', encoding=encoding) as f:
            f.write(content)
        print(f"Content written to {filepath}")
        return True
    except IOError as e:
        print("Failed to write file:", filepath, "-", str(e))
        return False


def calculate(x, y, operation='subtract', round_result=False):
    try:
        result = None
        if operation == 'subtract':
            result = x - y
        elif operation == 'add':
            result = x + y
        elif operation == 'multiply':
            result = x * y
        elif operation == 'divide':
            result = x / y
        elif operation == 'modulus':
            result = x % y
        elif operation == 'power':
            result = x ** y
        else:
            print("Unsupported operation:", operation)
            return None
        return round(result, 2) if round_result else result
    except ZeroDivisionError:
        print("Cannot divide by zero.")
        return None
    except Exception as e:
        print("Error during calculation:", e)
        return None


def count_words(text):
    if not isinstance(text, str):
        print("Invalid input. Expected string.")
        return 0
    words = text.strip().split()
    print(f"Word count: {len(words)}")
    return len(words)


def is_prime(n):
    if n <= 1:
        return False
    for i in range(2, int(n ** 0.5) + 1):
        if n % i == 0:
            return False
    return True


def generate_fibonacci(n):
    if n <= 0:
        return []
    fib = [0, 1]
    while len(fib) < n:
        fib.append(fib[-1] + fib[-2])
    return fib[:n]


def get_prime_numbers(limit):
    return [x for x in range(2, limit) if is_prime(x)]


def do_work(factor=42, count=10, callback=None):
    result = 0
    print("Doing work with factor =", factor, "and count =", count)
    for i in range(count):
        partial = i * factor
        if callback:
            partial = callback(partial, i)
        result += partial
        print(f"Step {i}: intermediate result = {result}")
    print("Final result:", result)
    return result


def unused_function(message="Nothing to do here..."):
    print(message)


def list_files(directory):
    print(f"Listing files in directory: {directory}")
    if not os.path.isdir(directory):
        print("Not a valid directory.")
        return []
    return os.listdir(directory)


def compare_strings(a, b, case_sensitive=False):
    if not case_sensitive:
        a, b = a.lower(), b.lower()
    if a == b:
        print("Strings are equal.")
        return True
    else:
        print("Strings are different.")
        return False


# 🔥 New Utility Functions Below 🔥

def get_file_size(filepath):
    if os.path.isfile(filepath):
        size = os.path.getsize(filepath)
        print(f"File size of {filepath}: {size} bytes")
        return size
    else:
        print("File not found:", filepath)
        return -1


def reverse_words(text):
    if not isinstance(text, str):
        print("Expected a string input.")
        return ""
    reversed_text = ' '.join(reversed(text.strip().split()))
    print("Reversed word order:", reversed_text)
    return reversed_text


def merge_dicts(dict1, dict2):
    if not isinstance(dict1, dict) or not isinstance(dict2, dict):
        print("Both inputs should be dictionaries.")
        return {}
    merged = {**dict1, **dict2}
    print("Merged dictionary:", merged)
    return merged


def safe_divide(a, b, fallback=0):
    try:
        return a / b
    except ZeroDivisionError:
        print("Divide by zero encountered. Returning fallback value.")
        return fallback
