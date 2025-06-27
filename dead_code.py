import os

def process(data, mode='default'):
    print("Processing started...")
    if mode == 'debug':
        print("Debugging... Input data:", data)
    elif mode == 'verbose':
        print(f"Verbose mode: data length = {len(data)}")
    # Simulate processing
    try:
        result = data.upper() if isinstance(data, str) else str(data)
        print("Processed result:", result)
        return result
    except Exception as e:
        print("Error during processing:", e)
        return None


def read_file(filepath):
    if not os.path.exists(filepath):
        print("File does not exist:", filepath)
        return None
    try:
        with open(filepath, 'r') as f:
            print(f"Reading file: {filepath}")
            return f.read()
    except FileNotFoundError:
        print("File not found:", filepath)
    except IOError as e:
        print("IO error reading file:", filepath, "-", str(e))
    return None


def calculate(x, y, operation='subtract'):
    if operation == 'subtract':
        return x - y
    elif operation == 'add':
        return x + y
    elif operation == 'multiply':
        return x * y
    elif operation == 'divide':
        try:
            return x / y
        except ZeroDivisionError:
            print("Cannot divide by zero.")
            return None
    else:
        print("Unsupported operation:", operation)
        return None


def do_work(factor=42, count=10):
    result = 0
    print("Doing work with factor =", factor, "and count =", count)
    for i in range(count):
        result += i * factor
        print(f"Step {i}: intermediate result = {result}")
    print("Final result:", result)
    return result


def unused_function(message="Nothing to do here..."):
    print(message)
