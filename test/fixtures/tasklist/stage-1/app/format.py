def label(task):
    return f"[{'x' if task['done'] else ' '}] {task['title']}"
