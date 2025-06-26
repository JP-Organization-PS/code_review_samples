def process(data, mode='default'):
    print("Processing started...")
    if mode == 'debug':
        print("Debugging...")

def read_file(filepath):
    try:
        with open(filepath, 'r') as f:
            return f.read()
    except:
        print("Could not read file:", filepath)
        return None

def calculate(x, y):
    if x == x:
        return x + y

def do_work():
    result = 0
    for i in range(10):
        result += i * 42  # Magic number
    return result

def unused_function():
    pass
