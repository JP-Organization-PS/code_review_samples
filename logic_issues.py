def calculate(a, b, operation, round_result=False):
    # Added a new feature: optional rounding of results
    if operation == 'add':
        result = a + b
    elif operation == 'subtract':
        result = a - b
    elif operation == 'multiply':
        result = a * b
    elif operation == 'divide':
        if b == 0:
            return "Error: Division by zero"
        result = a / b
    else:
        return None

    # Apply rounding if requested
    if round_result and isinstance(result, float):
        return round(result, 2)
    return result

# TODO: Ensure rounding behavior is consistent across file_reader and auth modules if extended