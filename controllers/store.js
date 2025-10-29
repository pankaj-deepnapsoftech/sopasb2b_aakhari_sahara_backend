const Store = require("../models/store");
const csv = require('csvtojson');
const fs = require('fs');
const { ErrorHandler, TryCatch } = require("../utils/error");
const { checkStoreCsvValidity } = require("../utils/checkStoreCsvValidity");

exports.create = TryCatch(async (req, res) => {
  const storeDetails = req.body;
  console.log("store1");
  if (!storeDetails) {
    throw new ErrorHandler("Please provide all the fields", 400);
  }
  console.log("store2");

  const store = await Store.create({ ...storeDetails, approved: req.user.isSuper });
console.log("store3");
  res.status(200).json({
    status: 200,
    success: true,
    message: "Store has been added successfully",
    store,
  });
});
exports.update = TryCatch(async (req, res) => {
  const { id } = req.params;
  const storeDetails = req.body;
  if (!id) {
    throw new ErrorHandler("Store Id not provided", 400);
  }
  if (!storeDetails) {
    throw new ErrorHandler("Please provide all the fields", 400);
  }
  let store = await Store.findById(id);
  if (!store) {
    throw new ErrorHandler("Store doesn't exist", 400);
  }

  store = await Store.findByIdAndUpdate(
    id,
    {
      ...storeDetails,
      approved: req.user.isSuper ? storeDetails?.approved : false,
    },
    { new: true }
  );

  res.status(200).json({
    status: 200,
    success: true,
    message: "Store has been updated successfully",
    store,
  });
});
exports.remove = TryCatch(async (req, res) => {
  const { id } = req.params;
  if (!id) {
    throw new ErrorHandler("Store Id not provided", 400);
  }
  let store = await Store.findById(id);
  if (!store) {
    throw new ErrorHandler("Store doesn't exist", 400);
  }

  await store.deleteOne();

  res.status(200).json({
    status: 200,
    success: true,
    message: "Store has been deleted successfully",
    store,
  });
});
exports.details = TryCatch(async (req, res) => {
  const { id } = req.params;
  if (!id) {
    throw new ErrorHandler("Store Id not provided", 400);
  }
  let store = await Store.findById(id);
  if (!store) {
    throw new ErrorHandler("Store doesn't exist", 400);
  }

  res.status(200).json({
    status: 200,
    success: true,
    store,
  });
});
exports.all = TryCatch(async (req, res) => {
  const stores = await Store.find({ approved: true }).sort({ updatedAt: -1 });
  res.status(200).json({
    status: 200,
    success: true,
    stores,
  });
});
exports.unapproved = TryCatch(async (req, res) => {
  const stores = await Store.find({ approved: false }).sort({ updatedAt: -1 });
  res.status(200).json({
    status: 200,
    success: true,
    unapproved: stores,
  });
});
exports.bulkUploadHandler = async (req, res) => {
  csv()
    .fromFile(req.file.path)
    .then(async (response) => {
      try {
        fs.unlink(req.file.path, () => {});

        await checkStoreCsvValidity(response);

        const stores = response;

        await Store.insertMany(stores);

        res.status(200).json({
          status: 200,
          success: true,
          message: "Stores has been added successfully",
        });
      } catch (error) {
        return res.status(400).json({
          status: 400,
          success: false,
          message: error?.message,
        });
      }
    });
};
