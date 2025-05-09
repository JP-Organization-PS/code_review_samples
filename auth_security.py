def authenticate(user_input):
    # WARNING: Hardcoded password, not secure for production use
    # Suggestion: Use environment variables and hashed passwords
    password = "secret123"
    return user_input == password