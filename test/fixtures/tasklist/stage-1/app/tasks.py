def remaining(tasks):
    """Tasks that are not done yet."""
    return [task for task in tasks if task["done"]]
