// Type utilities
export function normalizeDataType(typeString) {
  if (!typeString) return 'Text';

  const normalized = typeString.trim().toLowerCase();
  
  // Map variations to standard types
  const typeMap = {
    'text': 'Text',
    'json': 'Json',
    'boolean': 'Boolean',
    'number': 'Number',
    'integer': 'Integer',
    'interger': 'Integer', // Handle typo
    'array': 'Array',
    'date': 'Date',
    'datetime': 'DateTime',
    'map': 'Map',
    'url': 'Url',
    'structured data': 'StructuredData'
  };

  return typeMap[normalized] || 'Text';
}

export function generateInputJSON(inputs) {
  const json = {};
  
  for (const input of inputs) {
    let value = input.currentValue;
    
    // Handle empty values
    if (!value || value.trim() === '') {
      json[input.key] = null;
      continue;
    }

    // Type conversion
    try {
      switch (input.type) {
        case 'Json':
        case 'Array':
        case 'Map':
        case 'StructuredData':
          value = JSON.parse(value);
          break;
        
        case 'Boolean':
          value = value === 'true' || value === '1' || value === true;
          break;
        
        case 'Number':
        case 'Integer':
          value = parseFloat(value);
          if (isNaN(value)) value = null;
          break;
        
        case 'Date':
        case 'DateTime':
        case 'Url':
        case 'Text':
        default:
          // Keep as string
          break;
      }
    } catch (e) {
      console.error(`Error parsing value for ${input.key}:`, e);
      value = value || null;
    }
    
    json[input.key] = value;
  }
  
  return json;
}