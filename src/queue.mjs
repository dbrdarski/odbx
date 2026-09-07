export function createQueue() {
  const queue = [];
  const next = () => queue[0]().then(() => {
    queue.shift();
    if (queue.length) next();
  });
  return task => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(task).then(resolve, reject));
    if (queue.length === 1) next();
  });
}
