import data from './components-config.json';


function removeDups<T>(array: T[]): T[] {
  return [...new Set(array)];
}

const components = removeDups(data.map(item => item.name))

const path = './components.json'
await Bun.write(path, JSON.stringify(components, null, 2));
