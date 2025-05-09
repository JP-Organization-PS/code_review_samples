def process(data, mode='default'):
    # 'mode' parameter is never used - potential dead code
    result = []
    for i in data:
        if i % 2 == 0:
            result.append(i * 2)
        else:
            continue  # Unnecessary continue, can be removed
    temp = "this is dead code"  # Variable declared but never used
    return result