export function getFieldInputValue(field, value) {
  if (field?.type === 'string_list') {
    return Array.isArray(value) ? value.join(', ') : '';
  }
  return value ?? '';
}

export function normalizeFieldValue(field, value) {
  if (field?.type === 'select' && field?.nullable && value === '') return null;
  if (field?.type === 'string_list') {
    return String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value;
}
