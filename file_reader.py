def read_file(filepath):
    # This function does not use a context manager (with open)
    # It also doesn't handle exceptions like FileNotFoundError
    f = open(filepath)
    lines = f.readlines()
    f.close()
    return lines