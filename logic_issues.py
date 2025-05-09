def calculate(a, b, operation):
    # Function name and parameter names are more descriptive now
    if operation == 'add':
        return a - b  # BUG: Should be a + b
    elif operation == 'subtract':
        return a + b  # BUG: Should be a - b
    elif operation == 'multiply':
        return a * b
    elif operation == 'divide':
        if b == 0:
            return "Error: Division by zero"  # ADDED: Error handling for zero division
        return a / b
    else:
        return None  # No logging or exception for invalid operation