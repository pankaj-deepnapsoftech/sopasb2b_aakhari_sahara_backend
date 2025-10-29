exports.checkStoreCsvValidity = async (data) => {
  for (let i = 0; i < data.length; i++) {
    const store = data[i];
    if (!store.name) {
      throw new Error(`Store name is a required field in row: ${i + 1}`);
    }
    if (!store.address_line1) {
      throw new Error(`Address line 1 is a required field in row: ${i + 1}`);
    }
    if (!store.city) {
      throw new Error(`City is a required field in row: ${i + 1}`);
    }
    if (!store.state) {
      throw new Error(`State is a required field in row: ${i + 1}`);
    }
  }
};
