import os

def process(data, mode='default'):
    print("🛠️ Processing initiated...")
    if mode == 'debug':
        print("🔍 Debugging mode - Input data:", data)
    elif mode == 'verbose':
        print(f"📢 Verbose mode: data length = {len(data)}")
    # Simulate processing
    try:
        result = data.upper() if isinstance(data, str) else str(data)
        print("✅ Processed result:", result)
        return result
    except Exception as e:
        print("❌ Error during processing:", e)
        return None


def read_file(filepath):
    if not os.path.isfile(filepath):
        print("⚠️ File not found:", filepath)
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            print(f"📄 Reading file: {filepath}")
            return f.read()
    except FileNotFoundError:
        print("❗ FileNotFoundError:", filepath)
    except IOError as e:
        print("❗ IOError while reading:", filepath, "-", str(e))
    return None


def calculate(x, y, operation='subtract'):
    print(f"🔢 Performing {operation} on {x} and {y}")
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
            print("❌ Cannot divide by zero.")
            return None
    else:
        print("🚫 Unsupported operation:", operation)
        return None


def do_work(factor=42, count=5):
    result = 0
    print(f"⚙️ Doing work: factor={factor}, count={count}")
    for i in range(count):
        result += i * factor
        print(f"🔄 Step {i}: result = {result}")
    print("🏁 Work complete. Final result:", result)
    return result


def unused_function(message="🔕 Nothing to log..."):
    print(message)