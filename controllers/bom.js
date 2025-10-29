//bom controller

const mongoose = require('mongoose')

const BOM = require("../models/bom");

const BOMFinishedMaterial = require("../models/bom-finished-material");

const BOMRawMaterial = require("../models/bom-raw-material");

const BOMScrapMaterial = require("../models/bom-scrap-material");

const ProductionProcess = require("../models/productionProcess");

const Product = require("../models/product");

const InventoryShortage = require("../models/inventoryShortage");

const Item = require("../models/product");

const { TryCatch, ErrorHandler } = require("../utils/error");

const { generateBomId } = require("../utils/generateBomId");

const path = require("path");

const fs = require("fs");

const csv = require("csvtojson");

const { parseExcelFile } = require("../utils/parseExcelFile");

const { Purchase } = require("../models/purchase");



exports.create = TryCatch(async (req, res) => {

  const {

    raw_materials,

    processes,

    finished_good,

    approved_by,

    approval_date,

    bom_name,

    parts_count,

    total_cost,

    scrap_materials,

    other_charges,

    remarks,

    sales,

    resources,

    manpower

  } = req.body;





  const manpowerData = Array.isArray(manpower)

    ? manpower.map(mp => ({

      user: mp.user || null,

      number: String(mp.number ?? "0")

    }))

    : [];



  let insuffientStockMsg = "";



  if (

    !raw_materials ||

    raw_materials.length === 0 ||

    !finished_good ||

    !bom_name ||

    bom_name.trim().length === 0 ||

    total_cost === undefined

  ) {

    throw new ErrorHandler("Please provide all the fields", 400);

  }



  if (isNaN(parts_count) || isNaN(total_cost)) {

    throw new ErrorHandler("Part's count and Total cost must be a number", 400);

  }



  const isBomFinishedGoodExists = await Product.findById(finished_good.item);

  if (!isBomFinishedGoodExists) {

    throw new ErrorHandler("Finished good doesn't exist", 400);

  }



  // Get all products to group by name
  const products = await Product.find({ _id: { $in: raw_materials.map(m => m.item) } });
  
  // Group raw materials by item name and sum their quantities
  const groupedMaterials = {};
  raw_materials.forEach(material => {
    const product = products.find(p => p._id.toString() === material.item);
    if (product) {
      const itemName = product.name;
      if (!groupedMaterials[itemName]) {
        groupedMaterials[itemName] = {
          item: material.item,
          totalQuantity: 0,
          materials: [],
          product: product
        };
      }
      groupedMaterials[itemName].totalQuantity += Number(material.quantity) || 0;
      groupedMaterials[itemName].materials.push(material);
    }
  }); 

  // Check for stock shortages based on grouped materials
  const shortages = [];
  await Promise.all(
    Object.values(groupedMaterials).map(async (groupedMaterial) => {
      const isProdExists = await Product.findById(groupedMaterial.item);
      if (!isProdExists) {
        throw new ErrorHandler(`Raw material doesn't exist`, 400);
      }
      
      // Calculate total available stock (current_stock + updated_stock)
      const totalAvailableStock = (isProdExists.current_stock || 0);
      // console.log("tanish 1:", groupedMaterial.totalQuantity);
      // console.log("tanish 2:", totalAvailableStock);
      const quantityDifference = groupedMaterial.totalQuantity - totalAvailableStock;

      if (quantityDifference > 0) {
        insuffientStockMsg += ` Insufficient stock of ${isProdExists.name} (Required: ${groupedMaterial.totalQuantity}, Available: ${totalAvailableStock})`;
        shortages.push({
          item: groupedMaterial.item,
          shortage_quantity: quantityDifference,
          total_required: groupedMaterial.totalQuantity,
          available_stock: totalAvailableStock
        });
      }
    })
  );



  const { item, description, quantity, image, supporting_doc, comments, cost } =

    finished_good;



  const totalRawMaterialDecrease = raw_materials

    .filter(material => material.quantity < 0)

    .reduce((sum, material) => sum + Math.abs(material.quantity), 0);



  const adjustedFinishedGoodQuantity = quantity + totalRawMaterialDecrease;



  const createdFinishedGood = await BOMFinishedMaterial.create({

    item,

    description,

    quantity: adjustedFinishedGoodQuantity,

    image,

    supporting_doc,

    comments,

    cost,

  });



  // Generate auto BOM ID

  const bomId = await generateBomId();



  const bom = await BOM.create({

    bom_id: bomId,

    processes,

    finished_good: createdFinishedGood._id,

    approved_by,

    approval_date,

    bom_name,

    parts_count,

    total_cost,

    approved: req.user.isSuper,

    creator: req.user._id,

    other_charges,

    remarks,

    resources,

    manpower: manpowerData, // ✅ use processed manpower here

    sale_id: sales // Add sale_id from request body

  });



  if (raw_materials) {

    const bom_raw_materials = await Promise.all(

      raw_materials.map(async (material) => {

        const createdMaterial = await BOMRawMaterial.create({

          ...material,

          bom: bom._id,

        });

        return createdMaterial._id;

      })

    );

    bom.raw_materials = bom_raw_materials;

    await bom.save();

    // Create inventory shortages based on grouped materials
    for (const shortage of shortages) {
      // Find the first raw material record for this item to link the shortage
      const firstRawMaterial = await BOMRawMaterial.findOne({ 
        bom: bom._id, 
        item: shortage.item 
      });

      if (firstRawMaterial) {
        await InventoryShortage.create({
          bom: bom._id,
          raw_material: firstRawMaterial._id,
          item: shortage.item,
          shortage_quantity: shortage.shortage_quantity,
          original_shortage_quantity: shortage.shortage_quantity,
          total_required: shortage.total_required,
          available_stock: shortage.available_stock,
          is_resolved: false,
          should_recreate_on_edit: true,
        });
      }
    }

  }



  if (scrap_materials) {

    const bom_scrap_materials = await Promise.all(

      scrap_materials.map(async (material) => {

        const createdMaterial = await BOMScrapMaterial.create({

          ...material,

          bom: bom._id,

        });

        return createdMaterial._id;

      })

    );



    bom.scrap_materials = bom_scrap_materials;

    await bom.save();

  }



  if (insuffientStockMsg) {

    return res.status(400).json({

      status: 400,

      success: false,

      message: "BOM has been created successfully." + insuffientStockMsg,

      bom,

    });

  }



  res.status(200).json({

    status: 200,

    success: true,

    message: "BOM has been created successfully.",

    bom,

  });

});





exports.update = TryCatch(async (req, res) => {

  const { id } = req.params;

  const {

    approved,

    raw_materials,

    finished_good,

    bom_name,

    parts_count,

    total_cost,

    processes,

    scrap_materials,

    other_charges,

    remarks,

    resources,

    manpower // <-- raw manpower from request

  } = req.body;



  if (!id) {

    throw new ErrorHandler("id not provided", 400);

  }



  const bom = await BOM.findById(id)

    .populate("approved_by")

    .populate({ path: "finished_good", populate: { path: "item" } })

    .populate({ path: "raw_materials", populate: { path: "item" } })

    .populate({ path: "scrap_materials", populate: { path: "item" } });



  if (!bom) {

    throw new ErrorHandler("BOM not found", 400);

  }



  let insuffientStockMsg = "";

  const shortages = [];



  if (finished_good) {

    const isBomFinishedGoodExists = await Product.findById(finished_good.item);

    if (!isBomFinishedGoodExists) {

      throw new ErrorHandler("Finished good doesn't exist", 400);

    }

  }



  if (raw_materials) {
    // Get all products to group by name
    const products = await Product.find({ _id: { $in: raw_materials.map(m => m.item) } });
    
    // Group raw materials by item name and sum their quantities
    const groupedMaterials = {};
    raw_materials.forEach(material => {
      const product = products.find(p => p._id.toString() === material.item);
      if (product) {
        const itemName = product.name;
        if (!groupedMaterials[itemName]) {
          groupedMaterials[itemName] = {
            item: material.item,
            totalQuantity: 0,
            materials: [],
            product: product
          };
        }
        groupedMaterials[itemName].totalQuantity += Number(material.quantity) || 0;
        groupedMaterials[itemName].materials.push(material);
      }
    });

    await Promise.all(
      Object.values(groupedMaterials).map(async (groupedMaterial) => {
        const isProdExists = await Product.findById(groupedMaterial.item);
        if (!isProdExists) {
          throw new ErrorHandler(`Product doesn't exist`, 400);
        }

        // Calculate total available stock (current_stock + updated_stock)
        const totalAvailableStock = (isProdExists.current_stock || 0);
        const quantityDifference = groupedMaterial.totalQuantity - totalAvailableStock;

        if (quantityDifference > 0) {
          insuffientStockMsg += ` Insufficient stock of ${isProdExists.name} (Required: ${groupedMaterial.totalQuantity}, Available: ${totalAvailableStock})`;
          shortages.push({
            item: groupedMaterial.item,
            shortage_quantity: quantityDifference,
            total_required: groupedMaterial.totalQuantity,
            available_stock: totalAvailableStock
          });
        }
      })
    );
  }



  if (scrap_materials) {

    await Promise.all(

      scrap_materials.map(async (material) => {

        const isScrapMaterialExists = await BOMScrapMaterial.findById(material._id);

        if (isScrapMaterialExists) {

          const isProdExists = await Product.findById(material.item);

          if (!isProdExists) {

            throw new ErrorHandler(`Product doesn't exist`, 400);

          }

        }

      })

    );

  }



  if (finished_good) {

    const isProdExists = await Product.findById(finished_good.item);

    if (finished_good.item !== bom.finished_good.item._id.toString()) {

      bom.finished_good.item = finished_good.item;

    }



    const totalRawMaterialDecrease = raw_materials

      ? raw_materials.filter(material => material.quantity < 0)

        .reduce((sum, material) => sum + Math.abs(material.quantity), 0)

      : 0;



    const adjustedFinishedGoodQuantity = finished_good.quantity + totalRawMaterialDecrease;



    bom.finished_good.quantity = adjustedFinishedGoodQuantity;

    bom.finished_good.cost = finished_good.cost;

    bom.finished_good.comments = finished_good?.comments;

    bom.finished_good.description = finished_good?.description;

    bom.finished_good.supporting_doc = finished_good?.supporting_doc;



    await isProdExists.save();

  }



  if (raw_materials && raw_materials.length > 0) {
    // Get existing shortages for this BOM before deleting them
    const existingShortages = await InventoryShortage.find({ bom: bom._id });
    
    // Create a map of existing shortages by item for quick lookup
    const existingShortagesMap = new Map();
    existingShortages.forEach(shortage => {
      if (shortage.item) {
        existingShortagesMap.set(shortage.item.toString(), shortage);
      }
    });

    // Delete all existing shortages for this BOM
    await InventoryShortage.deleteMany({ bom: bom._id });

    // Process raw materials and create/update them
    const processedRawMaterials = [];
    
    await Promise.all(
      raw_materials.map(async (material) => {
        let rawMaterialRecord;
        
        if (material._id) {
          // Update existing raw material
          const isExistingRawMaterial = await BOMRawMaterial.findById(material._id);
          if (isExistingRawMaterial) {
            isExistingRawMaterial.item = material.item;
            isExistingRawMaterial.description = material?.description;
            isExistingRawMaterial.quantity = material.quantity;
            isExistingRawMaterial.assembly_phase = material?.assembly_phase;
            isExistingRawMaterial.supporting_doc = material?.supporting_doc;
            isExistingRawMaterial.comments = material?.comments;
            isExistingRawMaterial.total_part_cost = material?.total_part_cost;
            await isExistingRawMaterial.save();
            rawMaterialRecord = isExistingRawMaterial;
          }
        } else {
          // Create new raw material
          rawMaterialRecord = await BOMRawMaterial.create({
            ...material,
            bom: bom._id,
          });
        }
        
        if (rawMaterialRecord) {
          processedRawMaterials.push(rawMaterialRecord);
        }
      })
    );

    // Create inventory shortages based on grouped materials
    for (const shortage of shortages) {
      // Find the first raw material record for this item to link the shortage
      const firstRawMaterial = processedRawMaterials.find(
        rm => rm.item && rm.item.toString() === shortage.item.toString()
      );
      
      if (firstRawMaterial) {
        // Check if there was a previously resolved shortage for this item
        const existingShortage = existingShortagesMap.get(shortage.item.toString());
        
        let originalShortageQuantity = shortage.shortage_quantity;
        let shouldRecreateOnEdit = true;
        
        // If there was a previously resolved shortage, use its original quantity
        if (existingShortage && existingShortage.is_resolved) {
          originalShortageQuantity = existingShortage.original_shortage_quantity;
          shouldRecreateOnEdit = existingShortage.should_recreate_on_edit;
        }

        await InventoryShortage.create({
          bom: bom._id,
          raw_material: firstRawMaterial._id,
          item: shortage.item,
          shortage_quantity: shortage.shortage_quantity,
          original_shortage_quantity: originalShortageQuantity,
          total_required: shortage.total_required,
          available_stock: shortage.available_stock,
          is_resolved: false, // Reset to unresolved when BOM is edited
          resolved_at: null,
          resolved_by: null,
          should_recreate_on_edit: shouldRecreateOnEdit,
        });
      }
    }

  }



  if (scrap_materials) {

    await Promise.all(

      scrap_materials.map(async (material) => {

        const isExistingScrapMaterial = await BOMScrapMaterial.findById(material._id);

        if (isExistingScrapMaterial) {

          isExistingScrapMaterial.item = material.item;

          isExistingScrapMaterial.description = material?.description;

          isExistingScrapMaterial.quantity = material.quantity;

          isExistingScrapMaterial.total_part_cost = material?.total_part_cost;

          await isExistingScrapMaterial.save();

        }

      })

    );

  }



  if (processes && processes.length > 0) {

    bom.processes = processes;

  }

  if (typeof remarks === "string") {

    bom.remarks = remarks.trim();

  }





  if (Array.isArray(manpower)) {

    const manpowerData = manpower.map(mp => ({

      user: mp.user || null,

      number: String(mp.number ?? "0")

    }));

    bom.manpower = manpowerData;

  }



  if (Array.isArray(resources)) {

    const validResources = resources.filter((res) => res.resource_id);

    bom.resources = validResources;

  }



  if (bom_name && bom_name.trim().length > 0) bom.bom_name = bom_name;

  if (parts_count && parts_count > 0) bom.parts_count = parts_count;

  if (total_cost) bom.total_cost = total_cost;

  if (approved && req.user.isSuper) {

    bom.approved_by = req.user._id;

    bom.approved = true;

  }



  await bom.finished_good.save();

  await bom.save();



  if (insuffientStockMsg) {

    return res.status(400).json({

      status: 400,

      success: false,

      message: "BOM has been updated successfully" + insuffientStockMsg,

    });

  }



  res.status(200).json({

    status: 200,

    success: true,

    message: "BOM has been updated successfully",

  });

});





exports.remove = TryCatch(async (req, res) => {

  const { id } = req.params;

  if (!id) {

    throw new ErrorHandler("id not provided", 400);

  }

  const bom = await BOM.findById(id);

  if (!bom) {

    throw new ErrorHandler("BOM not found", 400);

  }



  const rawMaterials = bom.raw_materials.map((material) => material._id);

  const finishedGood = bom.finished_good._id;



  await BOMRawMaterial.deleteMany({ _id: { $in: rawMaterials } });

  await BOMFinishedMaterial.deleteOne({ _id: finishedGood });

  await InventoryShortage.deleteMany({ bom: id });



  await bom.deleteOne();

  res.status(200).json({

    status: 200,

    success: true,

    message: "BOM has been deleted successfully",

    bom,

  });

});



exports.details = TryCatch(async (req, res) => {

  const { id } = req.params;

  if (!id) {

    throw new ErrorHandler("id not provided", 400);

  }

  const bom = await BOM.findById(id)

    .populate("approved_by")

    .populate({

      path: "finished_good",

      populate: { path: "item" },

    })

    .populate({

      path: "raw_materials",

      populate: [{ path: "item" }],

    })

    .populate({

      path: "scrap_materials",

      populate: [{ path: "item" }],

    })



    .populate({

      path: "resources.resource_id",

      model: "Resource"

    });



  if (!bom) {

    throw new ErrorHandler("BOM not found", 400);

  }



  res.status(200).json({

    status: 200,

    success: true,

    bom,

  });

});



exports.all = TryCatch(async (req, res) => {

  const page = parseInt(req.query.page) || 1;

  const limit = parseInt(req.query.limit) || 100;

  const skip = (page - 1) * limit;



  const boms = await BOM.find({ approved: true })





    .populate({

      path: "finished_good",

      select: "item quantity",

      populate: {

        path: "item",

        select: "name",

      },

    })

    .populate({

      path: "raw_materials",

      select: "item quantity",

      populate: {

        path: "item",

        select: "name",

      },

    })

    .populate({

      path: "scrap_materials",

      select: "item quantity",

      populate: {

        path: "item",

        select: "name",

      },

    })

    .populate({

      path: "resources.resource_id",

      select: "name type specification",

    })

    .sort({ updatedAt: -1 })

    .skip(skip)

    .limit(limit);



  const transformedBoms = boms.map((bom) => {

    const bomObj = bom.toObject();

    bomObj.resources = bomObj.resources.map((res) => ({

      name: res.resource_id?.name || "",

      type: res.resource_id?.type || res.type,

      specification: res.resource_id?.specification || res.specification,

    }));



    return bomObj;

  });



  res.status(200).json({

    status: 200,

    success: true,

    message: "Approved BOMs fetched successfully",

    count: transformedBoms.length,

    page,

    limit,

    boms: transformedBoms,

  });

});



exports.unapproved = TryCatch(async (req, res) => {

  const boms = await BOM.find({ approved: false })

    .populate("approved_by")

    .populate({

      path: "finished_good",

      populate: [

        {

          path: "item",

        },

      ],

    })

    .populate({

      path: "raw_materials",

      populate: [

        {

          path: "item",

        },

      ],

    })

    .sort({ updatedAt: -1 });



  res.status(200).json({

    status: 200,

    success: true,

    boms,

  });

});







exports.autoBom = TryCatch(async (req, res) => {

  const ObjectId = mongoose.Types.ObjectId;

  console.log(req.query);

  const { product_id, quantity, price } = req.query;

  const QUANTITY = Number(quantity);



  if (!product_id) {

    throw new ErrorHandler("product id is required", 400);

  }



  const result = await BOM.aggregate([

    {

      $lookup: {

        from: "bom-finished-materials",

        localField: "finished_good",

        foreignField: "_id",

        as: "finished_good"

      }

    },

    { $unwind: "$finished_good" },

    {

      $lookup: {

        from: "products",

        localField: "finished_good.item",

        foreignField: "_id",

        as: "finished_good.item"

      }

    },

    { $unwind: "$finished_good.item" },

    {

      $match: {

        "finished_good.item._id": new ObjectId(product_id)

      }

    },

    {

      $project: {

        _id: 1

      }

    }

  ]);



  if (result.length === 0) {

    return res.status(400).json({

      status: 400,

      success: false,

      boms: "BOM does not exists"

    });

  }



  const originalBomDoc = await BOM.findById(result[0]._id)

    .populate({ path: 'finished_good', populate: { path: 'item' } })

    .populate({ path: 'raw_materials', populate: { path: 'item' } })

    .populate({ path: 'scrap_materials', populate: { path: 'item' } });



  // Prepare new BOM object in memory (not saved to DB)

  const newFinishedGood = {

    ...originalBomDoc.finished_good.toObject(),

    _id: new mongoose.Types.ObjectId(),

    quantity: QUANTITY,

    cost: Math.round(((price || originalBomDoc?.finished_good?.item?.price) * QUANTITY) * 100) / 100 // Round to 2 decimal places

  };

  const prod = await Product.findById(newFinishedGood.item);

  newFinishedGood.item = prod;



  const newBomDoc = {

    ...originalBomDoc.toObject(),

    finished_good: newFinishedGood,

    raw_materials: undefined, // will be replaced with newRawMaterials

    scrap_materials: undefined // will be replaced with newScrapMaterials

  };



  const oldFinishedGoodQty = originalBomDoc.finished_good.quantity;

  const newFinishedGoodQty = QUANTITY;



  // Prepare new raw materials

  const newRawMaterials = originalBomDoc.raw_materials.map((rm) => {

    const unitQty = rm.quantity / oldFinishedGoodQty;

    const unitPrice = rm.quantity > 0 ? (rm.total_part_cost || 0) / rm.quantity : 0;

    const newQty = unitQty * newFinishedGoodQty;

    return {

      ...rm.toObject(),

      _id: new mongoose.Types.ObjectId(),

      quantity: Math.round(newQty * 100) / 100,

      total_part_cost: Math.round((unitPrice * newQty) * 100) / 100,

      bom: undefined

    };

  });



  // Prepare new scrap materials

  const newScrapMaterials = originalBomDoc.scrap_materials.map((sc) => {

    const unitQty = sc.quantity / oldFinishedGoodQty;

    const unitPrice = sc.quantity > 0 ? (sc.total_part_cost || 0) / sc.quantity : 0;

    const newQty = unitQty * newFinishedGoodQty;

    return {

      ...sc.toObject(),

      _id: new mongoose.Types.ObjectId(),

      quantity: Math.round(newQty * 100) / 100,

      total_part_cost: Math.round((unitPrice * newQty) * 100) / 100,

      bom: undefined

    };

  });



  // ✅ Generate BOM ID for the new auto-created BOM

  const bomId = await generateBomId();



  // Create the BOM without materials first

  const bomWithoutMaterials = {

    ...newBomDoc,

    bom_id: bomId, // <-- Auto-generated BOM ID

    raw_materials: [],

    scrap_materials: []

  };



  delete bomWithoutMaterials._id;



  const savedBom = await BOM.create(bomWithoutMaterials);

  console.log("savedBom --->>>", savedBom);



  // Create BOMFinishedMaterial document

  const createdFinishedGood = await BOMFinishedMaterial.create({

    ...newBomDoc.finished_good

  });



  // Create BOMRawMaterial documents

  const createdRawMaterials = await Promise.all(

    newRawMaterials.map(async (rm) => {

      const rawMaterial = await BOMRawMaterial.create({

        ...rm,

        bom: savedBom._id

      });

      return rawMaterial._id;

    })

  );



  // Create BOMScrapMaterial documents

  const createdScrapMaterials = await Promise.all(

    newScrapMaterials.map(async (sm) => {

      const scrapMaterial = await BOMScrapMaterial.create({

        ...sm,

        bom: savedBom._id

      });

      return scrapMaterial._id;

    })

  );



  // Calculate total cost

  const rawMaterialsTotalCost = newRawMaterials.reduce((sum, rm) => sum + (rm.total_part_cost || 0), 0);

  const totalCost = Math.round(rawMaterialsTotalCost * 100) / 100;



  // Update the saved BOM

  savedBom.finished_good = createdFinishedGood._id;

  savedBom.raw_materials = createdRawMaterials;

  savedBom.scrap_materials = createdScrapMaterials;

  savedBom.total_cost = totalCost;

  await savedBom.save();



  res.status(200).json({

    status: 200,

    success: true,

    boms: "orignia",

    originalBomDoc: originalBomDoc,

    newBomDoc: newBomDoc

  });

});







exports.findFinishedGoodBom = TryCatch(async (req, res) => {

  const { _id } = req.params;

  if (!_id) {

    throw new ErrorHandler("Id not provided", 400);

  }



  const allBoms = await BOM.find().populate("finished_good");

  const boms = allBoms.filter((bom) => {

    return bom.finished_good.item.toString() === _id;

  });



  res.status(200).json({

    status: 200,

    success: true,

    boms: boms,

  });

});



exports.unapprovedRawMaterialsForAdmin = TryCatch(async (req, res) => {

  const unapprovedProducts = await BOMRawMaterial.find({

    approvedByAdmin: false,

  })

    .sort({

      updatedAt: -1,

    })

    .populate({

      path: "bom",

      populate: {

        path: "raw_materials",

        populate: {

          path: "item",

        },

      },

    });



  const unapprovedRawMaterials = unapprovedProducts.flatMap((prod) => {

    const rm = prod.bom.raw_materials.filter(

      (i) => i.item._id.toString() === prod.item.toString()

    )[0];



    return {

      bom_name: prod.bom._doc.bom_name,

      ...rm.item._doc,

      _id: prod._id,

    };

  });



  res.status(200).json({

    status: 200,

    success: true,

    unapproved: unapprovedRawMaterials,

  });

});



exports.approveRawMaterialForAdmin = TryCatch(async (req, res) => {

  if (!req.user.isSuper) {

    throw new ErrorHandler(

      "You are not allowed to perform this operation",

      401

    );

  }

  const { _id } = req.body;

  if (!_id) {

    throw new ErrorHandler("Raw material id not provided", 400);

  }



  const updatedRawMaterial = await BOMRawMaterial.findByIdAndUpdate(

    { _id },

    { approvedByAdmin: true },

    { new: true }

  );



  res.status(200).json({

    status: 200,

    success: true,

    message: "Raw material's approval sent to inventory personnel successfully",

  });

});



exports.unapprovedRawMaterials = TryCatch(async (req, res) => {

  const unapprovedProducts = await BOMRawMaterial.find({

    approvedByInventoryPersonnel: false,

  })

    .sort({

      updatedAt: -1,

    })

    .populate({

      path: "bom",

      // match: { production_process: { $exists: true } }, //new condition to filter BOMs with production_process

      populate: {

        path: "raw_materials",

        populate: {

          path: "item",

        },

      },

    });



  const unapprovedRawMaterials = unapprovedProducts.flatMap((prod) => {

    const rm = prod.bom.raw_materials.find(

      (i) => i.item._id.toString() === prod.item.toString()

    );



    return {

      bom_id: prod.bom._id, // required to update status

      bom_name: prod.bom.bom_name,

      bom_status: prod.bom.production_process_status || "raw material approval pending", // optional fallback

      ...rm.item._doc,

      _id: prod._id, // raw material ID

    };

  });





  res.status(200).json({

    status: 200,

    success: true,

    unapproved: unapprovedRawMaterials,

  });

});



exports.approveRawMaterial = TryCatch(async (req, res) => {

  const { _id } = req.body;

  if (!_id) throw new ErrorHandler("Raw material id not provided", 400);



  const updatedRawMaterial = await BOMRawMaterial.findByIdAndUpdate(

    _id,

    {

      approvedByInventoryPersonnel: true,

      isInventoryApprovalClicked: true // ✅ mark clicked for this raw material

    },

    { new: true }

  );

  if (!updatedRawMaterial) throw new ErrorHandler("Raw material not found", 404);



  const requiredBom = await BOM.findById(updatedRawMaterial.bom).populate("raw_materials");



  const allApproved = requiredBom.raw_materials.every(

    rm => rm.approvedByInventoryPersonnel

  );



  if (allApproved && requiredBom.production_process) {

    await ProductionProcess.findByIdAndUpdate(

      requiredBom.production_process,

      { status: "Inventory Allocated" }

    );

  }



  res.status(200).json({

    status: 200,

    success: true,

    message: "Raw material approval updated",

    rawMaterial: updatedRawMaterial

  });

});







exports.bomsGroupedByWeekDay = TryCatch(async (req, res) => {

  const allBoms = await BOM.find({ approved: true }).select(

    "bom_name createdAt"

  );



  const result = {};



  allBoms.forEach((bom) => {

    const day = new Date(bom.createdAt).toLocaleDateString("en-IN", {

      timeZone: "Asia/Kolkata",

      weekday: "long",

    });



    if (!result[day]) result[day] = [];



    result[day].push({

      name: bom.bom_name,

      date: new Date(bom.createdAt).toLocaleDateString("en-IN"),

      id: bom._id,

    });

  });



  res.status(200).json({

    success: true,

    weekMap: result,

  });

});



exports.getInventoryShortages = TryCatch(async (req, res) => {

  const page = parseInt(req.query.page) || 1;

  const limit = parseInt(req.query.limit) || 100;

  const skip = (page - 1) * limit;



  const shortages = await InventoryShortage.find()

    .populate({

      path: "item",

      select: "name current_stock updated_stock price updated_price",

    })

    .populate({

      path: "bom",

      select: "bom_name",

    })

    .sort({ updatedAt: -1 })

    .skip(skip)

    .limit(limit);



  const formattedShortages = shortages.map(shortage => ({
    bom_name: shortage.bom?.bom_name || 'Unknown BOM',
    item_name: shortage.item?.name || 'Unknown Item',
    item: shortage.item?._id || null,
    shortage_quantity: shortage.shortage_quantity,
    total_required: shortage.total_required || shortage.shortage_quantity,
    available_stock: shortage.available_stock || shortage.item?.current_stock || 0,
    current_stock: shortage.item?.current_stock || 0,
    updated_stock: shortage.item?.updated_stock || null,
    current_price: shortage.item?.price || 0,
    updated_price: shortage.item?.updated_price || null,
    updated_at: shortage.updatedAt,
    is_grouped: shortage.total_required && shortage.total_required !== shortage.shortage_quantity,
  }));



  res.status(200).json({

    status: 200,

    success: true,

    message: "Inventory shortages fetched successfully",

    count: formattedShortages.length,

    page,

    limit,

    shortages: formattedShortages,

  });

});

exports.allRawMaterialsForInventory = TryCatch(async (req, res) => {
  const allRawMaterials = await BOMRawMaterial.find()
    .populate("item")
    .populate({
      path: "bom",
      select: "bom_name production_process",
      populate: [
        {
          path: "production_process",
          select: "status",
        },
        {
          path: "raw_materials.item",
        },
      ],
    });

  const allowedStatuses = [
    "raw material approval pending",
    "raw materials approved",
    "Inventory Allocated",
    "request for allow inventory",
    "inventory in transit",
  ];

  const results = [];

  for (const rm of allRawMaterials) {
    const bom = rm.bom;
    const item = rm.item;

    if (!bom || !item || !bom.production_process) continue;

    const productionProcess = await ProductionProcess.findById(bom.production_process);
    if (!productionProcess) continue;

    if (!allowedStatuses.includes(productionProcess.status)) continue;

    results.push({
      _id: rm._id,
      bom_id: bom._id,
      bom_name: bom.bom_name,
      bom_status: productionProcess.status,
      production_process_id: productionProcess._id,
      product_id: item.product_id,
      name: item.name,
      inventory_category: item.inventory_category,
      uom: item.uom,
      category: item.category,
      current_stock: item.current_stock,
      price: item.price,
      approved: item.approved,
      item_type: item.item_type,
      product_or_service: item.product_or_service,
      store: item.store,
      createdAt: rm.createdAt,
      updatedAt: rm.updatedAt,
      __v: rm.__v,
      change_type: rm.change_type,
      quantity_changed: rm.quantity_changed,
      isInventoryApprovalClicked: rm.isInventoryApprovalClicked,
      isOutForInventoryClicked:rm.isOutForInventoryClicked,
    });
  }

  res.status(200).json({
    status: 200,
    success: true,
    unapproved: results,
  });
});


// Get all finished goods for inventory

// exports.allFinishedGoodsForInventory = TryCatch(async (req, res) => {

//   const allFinishedGoods = await BOMFinishedMaterial.find()

//     .populate("item") // product details

//     .populate({

//       path: "bom",

//       select: "bom_name production_process",

//     });



//   const results = [];



//   for (const fg of allFinishedGoods) {

//     const bom = fg.bom;

//     if (!bom || !bom.production_process) continue;



//     const productionProcess = await ProductionProcess.findById(bom.production_process);

//     if (!productionProcess) continue;



//     const item = fg.item;



//     results.push({

//       _id: fg._id,

//       bom_id: bom._id,

//       bom_name: bom.bom_name,

//       bom_status: productionProcess.status,

//       production_process_id: productionProcess._id,

//       product_id: item?.product_id,

//       name: item?.name,

//       uom: item?.uom,

//       current_stock: item?.current_stock,

//       price: item?.price,

//       createdAt: fg.createdAt,

//       updatedAt: fg.updatedAt,

//       quantity: fg.quantity,

//       isInventoryReceived: fg.isInventoryReceived || false

//     });

//   }



//   res.status(200).json({

//     status: 200,

//     success: true,

//     unapproved: results,

//   });

// });





// // Approve / Move finished good to inventory

// exports.approveFinishedGood = TryCatch(async (req, res) => {

//   const { _id } = req.body;

//   if (!_id) throw new ErrorHandler("Finished good id not provided", 400);



//   const updatedFG = await BOMFinishedMaterial.findByIdAndUpdate(

//     _id,

//     { isInventoryReceived: true },  

//     { new: true }

//   );

//   if (!updatedFG) throw new ErrorHandler("Finished good not found", 404);



//   // Optionally update production process status

//   const bom = await BOM.findById(updatedFG.bom);

//   if (bom?.production_process) {

//     await ProductionProcess.findByIdAndUpdate(

//       bom.production_process,

//       { status: "Inventory Received" }

//     );

//   }



//   res.status(200).json({

//     status: 200,

//     success: true,

//     message: "Finished good moved to inventory successfully",

//     finishedGood: updatedFG

//   });

// });



exports.bulkUploadBOMHandler = TryCatch(async (req, res) => {

  const ext = path.extname(req.file.originalname).toLowerCase();

  let parsedData = [];



  if (!req.file) {

    throw new ErrorHandler("No file uploaded", 400);

  }



  try {

    if (ext === ".csv") {

      parsedData = await csv().fromFile(req.file.path);

    } else if (ext === ".xlsx") {

      parsedData = parseExcelFile(req.file.path);

    } else {

      throw new ErrorHandler("Unsupported file type. Please upload .csv or .xlsx", 400);

    }



    fs.unlink(req.file.path, () => { }); // Remove uploaded file



    if (!Array.isArray(parsedData) || parsedData.length === 0) {

      throw new ErrorHandler("No valid data found in uploaded file", 400);

    }



    const createdBOMs = [];



    for (const bomData of parsedData) {

      const {

        bom_name,

        parts_count,

        total_cost,

        raw_materials,

        finished_good,

        processes,

        other_charges,

        remarks,

      } = bomData;



      let parsedRawMaterials = [];

      let parsedFinishedGood = {};


      try {

        parsedRawMaterials = JSON.parse(raw_materials);

        if (!Array.isArray(parsedRawMaterials)) throw new Error();

      } catch (err) {

        throw new ErrorHandler(`Invalid JSON format for raw_materials in BOM: ${bom_name}`, 400);

      }



      try {

        parsedFinishedGood = JSON.parse(finished_good);

      } catch (err) {

        throw new ErrorHandler(`Invalid JSON format for finished_good in BOM: ${bom_name}`, 400);

      }



      const createdFinishedGood = await BOMFinishedMaterial.create({

        item: parsedFinishedGood.item,

        description: parsedFinishedGood.description,

        quantity: parsedFinishedGood.quantity,

        image: parsedFinishedGood.image,

        supporting_doc: parsedFinishedGood.supporting_doc,

        comments: parsedFinishedGood.comments,

        cost: parsedFinishedGood.cost,

      });



      const bom = await BOM.create({

        bom_name,

        parts_count,

        total_cost,

        processes,

        other_charges,

        remarks,

        approved_by: req.user._id,

        approval_date: new Date(),

        approved: req.user.isSuper,

        creator: req.user._id,

        finished_good: createdFinishedGood._id,

      });



      const bom_raw_materials = await Promise.all(

        parsedRawMaterials.map(async (material) => {

          const createdMaterial = await BOMRawMaterial.create({

            ...material,

            bom: bom._id,

          });

          return createdMaterial._id;

        })

      );



      bom.raw_materials = bom_raw_materials;

      await bom.save();

      createdBOMs.push(bom);

    }



    res.status(200).json({

      success: true,

      message: "Bulk BOM upload successful",

      boms: createdBOMs,

    });

  } catch (error) {

    res.status(400).json({

      success: false,

      message: error.message || "Bulk BOM upload failed",

    });

  }

});



// Get inventory approval status for a specific sales order

exports.getInventoryApprovalStatus = TryCatch(async (req, res) => {

  const { salesOrderId } = req.params;



  try {

    // Find BOM linked to this sales order - try different possible field names

    let bom = await BOM.findOne({ sale_id: salesOrderId });



    if (!bom) {

      // Try alternative field names

      bom = await BOM.findOne({ sales_order: salesOrderId });

    }



    if (!bom) {

      bom = await BOM.findOne({ purchase_id: salesOrderId });

    }



    if (!bom) {

      bom = await BOM.findOne({ order_id: salesOrderId });

    }



    if (!bom) {

      return res.status(200).json({

        status: 200,

        success: true,

        inventoryStatus: "No BOM assigned",

        details: [],

        totalMaterials: 0,

        approvedMaterials: 0,

        pendingMaterials: 0

      });

    }



    // Get all raw materials for this BOM

    const rawMaterials = await BOMRawMaterial.find({ bom: bom._id })

      .populate("item")

      .populate({

        path: "bom",

        select: "bom_name production_process",

        populate: {

          path: "raw_materials.item",

        },

      });



    if (rawMaterials.length === 0) {

      return res.status(200).json({

        status: 200,

        success: true,

        inventoryStatus: "No raw materials found",

        details: [],

        totalMaterials: 0,

        approvedMaterials: 0,

        pendingMaterials: 0

      });

    }



    // Calculate overall status

    const totalMaterials = rawMaterials.length;

    const approvedMaterials = rawMaterials.filter(rm => rm.isInventoryApprovalClicked).length;

    const pendingMaterials = totalMaterials - approvedMaterials;



    let overallStatus = "Pending";

    if (approvedMaterials === totalMaterials) {

      overallStatus = "Approved";

    } else if (approvedMaterials > 0) {

      overallStatus = "Partially Approved";

    }



    const details = rawMaterials.map(rm => ({

      _id: rm._id,

      product_id: rm.item?.product_id,

      name: rm.item?.name,

      inventory_category: rm.item?.inventory_category,

      uom: rm.item?.uom,

      current_stock: rm.item?.current_stock,

      price: rm.item?.price,

      approved: rm.isInventoryApprovalClicked,

      isInventoryApprovalClicked: rm.isInventoryApprovalClicked

    }));



    res.status(200).json({

      status: 200,

      success: true,

      inventoryStatus: overallStatus,

      totalMaterials,

      approvedMaterials,

      pendingMaterials,

      details

    });

  } catch (error) {

    console.error("Error in getInventoryApprovalStatus:", error);

    res.status(500).json({

      status: 500,

      success: false,

      message: "Internal server error",

      error: error.message

    });

  }

});



// Add missing approved function

exports.approved = TryCatch(async (req, res) => {

  const boms = await BOM.find({ approved: true })

    .populate("approved_by")

    .populate({

      path: "finished_good",

      populate: [

        {

          path: "item",

        },

      ],

    })

    .populate({

      path: "raw_materials",

      populate: [

        {

          path: "item",

        },

      ],

    })

    .sort({ updatedAt: -1 });



  res.status(200).json({

    status: 200,

    success: true,

    boms,

  });

});



// Get comprehensive status for a specific sales order or all sales orders

exports.getSalesOrderStatus = TryCatch(async (req, res) => {

  const { salesOrderId } = req.params;



  try {

    // Check if user wants all sales orders

    if (salesOrderId === "all") {

      return await getAllSalesOrdersStatus(req, res);

    }



    // Validate if salesOrderId is a valid ObjectId format

    if (!salesOrderId || salesOrderId === "YOUR_SALES_ORDER_ID" || salesOrderId.length !== 24) {

      return res.status(400).json({

        status: 400,

        success: false,

        message: "Invalid sales order ID format. Please provide a valid 24-character ID or 'all' for all sales orders.",

        salesOrderId: salesOrderId

      });

    }



    // First, check if the provided ID is a BOM ID itself

    let bom = await BOM.findById(salesOrderId);



    // If not found as BOM ID, try to find BOM linked to this sales order

    if (!bom) {

      bom = await BOM.findOne({ sale_id: salesOrderId });

    }



    // If no BOM found by sale ID, don't use any random BOM

    // Each sales order should have its own BOM or no BOM

    if (!bom) {

      // No BOM found for this sales order

      return res.status(200).json({

        status: 200,

        success: true,

        salesOrderId,

        overallStatus: "No BOM assigned",

        bomStatus: "Not Created",

        bomName: "N/A",

        bomId: "N/A",

        inventoryStatus: "Not Available",

        productionStatus: "Not Available",

        inventoryDetails: [],

        productionDetails: null,

        canCreateBOM: true,

        canApproveInventory: false,

        canRequestInventory: false,

        canOutAllotInventory: false,

        canStartProduction: false

      });

    }



    if (!bom) {

      return res.status(200).json({

        status: 200,

        success: true,

        salesOrderId,

        overallStatus: "No BOM assigned",

        bomStatus: "Not Created",

        inventoryStatus: "Not Available",

        productionStatus: "Not Available",

        inventoryDetails: [],

        productionDetails: null,

        canCreateBOM: true,

        canApproveInventory: false,

        canRequestInventory: false,

        canOutAllotInventory: false,

        canStartProduction: false

      });

    }



    // Get production process if exists

    let productionProcess = null;

    if (bom.production_process) {

      productionProcess = await ProductionProcess.findById(bom.production_process)

        .populate('creator', 'first_name last_name email')

        .populate('item', 'name product_id')

        .populate('rm_store', 'name')

        .populate('fg_store', 'name')

        .populate('scrap_store', 'name');

    }



    // Get all raw materials for this BOM

    const rawMaterials = await BOMRawMaterial.find({ bom: bom._id })

      .populate("item")

      .populate({

        path: "bom",

        select: "bom_name production_process",

        populate: {

          path: "raw_materials.item",

        },

      });



    // Calculate inventory status

    const totalMaterials = rawMaterials.length;

    const approvedMaterials = rawMaterials.filter(rm => rm.isInventoryApprovalClicked).length;

    const pendingMaterials = totalMaterials - approvedMaterials;



    let inventoryStatus = "Pending";

    if (approvedMaterials === totalMaterials && totalMaterials > 0) {

      inventoryStatus = "Approved";

    } else if (approvedMaterials > 0) {

      inventoryStatus = "Partially Approved";

    } else if (totalMaterials === 0) {

      inventoryStatus = "No Materials";

    }



    // Determine production status

    let productionStatus = "Not Started";

    if (productionProcess) {

      productionStatus = productionProcess.status;

    }



    // Determine overall status

    let overallStatus = "Pending";

    if (inventoryStatus === "Approved" && productionStatus === "inventory allocated") {

      overallStatus = "Ready for Production";

    } else if (productionStatus === "production started") {

      overallStatus = "Production Started";

    } else if (productionStatus === "production in progress") {

      overallStatus = "Production in Progress";

    } else if (productionStatus === "completed") {

      overallStatus = "Completed";

    } else if (inventoryStatus === "Approved") {

      overallStatus = "Inventory Approved";

    } else if (inventoryStatus === "Partially Approved") {

      overallStatus = "Partially Approved";

    }



    // Determine available actions

    const canCreateBOM = !bom;

    const canApproveInventory = inventoryStatus !== "Approved" && totalMaterials > 0;

    const canRequestInventory = inventoryStatus === "Approved" && (!productionProcess || productionProcess.status === "raw material approval pending");

    const canOutAllotInventory = productionProcess && productionProcess.status === "request for allow inventory";

    const canStartProduction = productionProcess && productionProcess.status === "inventory in transit";



    const inventoryDetails = rawMaterials.map(rm => ({

      _id: rm._id,

      product_id: rm.item?.product_id,

      name: rm.item?.name,

      inventory_category: rm.item?.inventory_category,

      uom: rm.item?.uom,

      current_stock: rm.item?.current_stock,

      price: rm.item?.price,

      approved: rm.isInventoryApprovalClicked,

      isInventoryApprovalClicked: rm.isInventoryApprovalClicked,

      quantity: rm.quantity,

      description: rm.description,

      comments: rm.comments,

      total_part_cost: rm.total_part_cost,

      in_production: rm.in_production,

      approvedByAdmin: rm.approvedByAdmin,

      approvedByInventoryPersonnel: rm.approvedByInventoryPersonnel

    }));



    const productionDetails = productionProcess ? {

      _id: productionProcess._id,

      process_id: productionProcess.process_id || productionProcess._id,

      process_name: productionProcess.process_name || `Production Process ${productionProcess._id}`,

      status: productionProcess.status,

      quantity: productionProcess.quantity,

      creator: productionProcess.creator,

      item: productionProcess.item,

      rm_store: productionProcess.rm_store,

      fg_store: productionProcess.fg_store,

      scrap_store: productionProcess.scrap_store,

      processes: productionProcess.processes,

      raw_materials: productionProcess.raw_materials,

      scrap_materials: productionProcess.scrap_materials,

      finished_good: productionProcess.finished_good,

      createdAt: productionProcess.createdAt,

      updatedAt: productionProcess.updatedAt

    } : null;



    res.status(200).json({

      status: 200,

      success: true,

      salesOrderId,

      overallStatus,

      bomStatus: bom.approved ? "Approved" : "Pending",

      bomName: bom.bom_name || "N/A",

      bomId: bom.bom_id || "N/A",

      bomDetails: {

        _id: bom._id,

        bom_id: bom.bom_id,

        bom_name: bom.bom_name,

        approved: bom.approved,

        is_production_started: bom.is_production_started,

        parts_count: bom.parts_count,

        total_cost: bom.total_cost,

        remarks: bom.remarks,

        creator: bom.creator,

        approved_by: bom.approved_by,

        finished_good: bom.finished_good,

        raw_materials: bom.raw_materials,

        scrap_materials: bom.scrap_materials,

        resources: bom.resources,

        manpower: bom.manpower,

        processes: bom.processes,

        other_charges: bom.other_charges,

        createdAt: bom.createdAt,

        updatedAt: bom.updatedAt

      },

      inventoryStatus,

      productionStatus,

      totalMaterials,

      approvedMaterials,

      pendingMaterials,

      inventoryDetails,

      productionDetails,

      canCreateBOM,

      canApproveInventory,

      canRequestInventory,

      canOutAllotInventory,

      canStartProduction,

      bomId: bom._id,

      productionProcessId: productionProcess?._id,

      productionProcessName: productionProcess?.process_name || productionProcess?._id || "N/A"

    });



  } catch (error) {

    console.error("Error in getSalesOrderStatus:", error);

    res.status(500).json({

      status: 500,

      success: false,

      message: "Internal server error",

      error: error.message

    });

  }

});



// Get all BOMs with their details

exports.getAllBOMs = TryCatch(async (req, res) => {

  try {

    const allBOMs = await BOM.find({})

      .populate('finished_good')

      .populate('creator', 'first_name last_name email')

      .sort({ createdAt: -1 });



    // Get all sales orders to link with BOMs

    const allSalesOrders = await Purchase.find({})

      .populate('party')

      .populate('product_id')

      .sort({ createdAt: -1 });



    const bomDetails = allBOMs.map((bom, index) => {

      // If BOM doesn't have sale_id, assign it to a sales order

      let sale_id = bom.sale_id;

      if (!sale_id && allSalesOrders[index]) {

        sale_id = allSalesOrders[index]._id;

        // Update BOM with sale_id (optional - uncomment if you want to save)

        // bom.sale_id = sale_id;

        // bom.save();

      }



      return {

        _id: bom._id,

        bom_id: bom.bom_id,

        bom_name: bom.bom_name,

        sale_id: sale_id,

        original_sale_id: bom.sale_id, // Show original sale_id

        approved: bom.approved,

        creator: bom.creator,

        finished_good: bom.finished_good,

        createdAt: bom.createdAt

      };

    });



    res.status(200).json({

      status: 200,

      success: true,

      message: "All BOMs fetched successfully",

      totalBOMs: allBOMs.length,

      totalSalesOrders: allSalesOrders.length,

      boms: bomDetails

    });

  } catch (error) {

    console.error("Error in getAllBOMs:", error);

    res.status(500).json({

      status: 500,

      success: false,

      message: "Internal server error",

      error: error.message

    });

  }

});



// Get status for all sales orders

const getAllSalesOrdersStatus = async (req, res) => {

  try {

    // Get all sales orders (purchases)

    const allSalesOrders = await Purchase.find({})

      .populate('party')

      .populate('product_id')

    // .sort({ createdAt: -1 });


    if (!allSalesOrders || allSalesOrders.length === 0) {

      return res.status(200).json({

        status: 200,

        success: true,

        message: "No sales orders found",

        totalSalesOrders: 0,

        salesOrdersStatus: []

      });

    }



    // Get all BOMs

    const allBOMs = await BOM.find({})

      .populate('finished_good')

      .populate('raw_materials')

      .populate('scrap_materials')

      .populate('resources.resource_id')

      .populate('creator', 'first_name last_name email')

      .populate('approved_by', 'first_name last_name email');



    // Get all production processes

    const allProductionProcesses = await ProductionProcess.find({})

      .populate('creator', 'first_name last_name email')

      .populate('item', 'name product_id')

      .populate('rm_store', 'name')

      .populate('fg_store', 'name')

      .populate('scrap_store', 'name');



    // Get all raw materials

    const allRawMaterials = await BOMRawMaterial.find({})

      .populate('item')

      .populate('bom');

    const salesOrdersStatus = [];

    // Process each sales order

    for (const salesOrder of allSalesOrders) {

      // Find BOM for this sales order

      let bom = null;



      // Check if sales order ID is a BOM ID itself

      bom = await BOM.findById(salesOrder._id);



      // Check by sale_id

      if (!bom) {

        bom = await BOM.findOne({ sale_id: salesOrder._id });

      }



      // Find BOM linked to this sales order (using existing BOMs array)

      let linkedBom = allBOMs.find(b =>

        b.sale_id?.toString() === salesOrder._id.toString() ||

        b.sales_order?.toString() === salesOrder._id.toString() ||

        b.purchase_id?.toString() === salesOrder._id.toString() ||

        b.order_id?.toString() === salesOrder._id.toString()

      );



      // If no BOM found by sale_id, try to assign a BOM by index

      if (!linkedBom && allBOMs.length > 0) {

        const salesOrderIndex = allSalesOrders.findIndex(so => so._id.toString() === salesOrder._id.toString());

        if (salesOrderIndex >= 0 && salesOrderIndex < allBOMs.length) {

          linkedBom = allBOMs[salesOrderIndex];

        }

      }



      if (linkedBom) {

        bom = linkedBom; // Use the found BOM

      }







      // If no BOM found, create basic status

      if (!bom) {

        salesOrdersStatus.push({

          salesOrderId: salesOrder._id,

          salesOrderNumber: salesOrder.order_id || salesOrder._id,

          buyerName: salesOrder.party?.name || "N/A",

          sellerName: "N/A", // Purchase model doesn't have seller

          totalAmount: (salesOrder.price * salesOrder.product_qty) || 0,

          orderDate: salesOrder.createdAt,

          overallStatus: "No BOM assigned",

          bomStatus: "Not Created",

          bomName: "N/A",

          bomId: "N/A",

          inventoryStatus: "Not Available",

          productionStatus: "Not Available",

          totalMaterials: 0,

          approvedMaterials: 0,

          pendingMaterials: 0,

          inventoryDetails: [],

          productionDetails: null,

          canCreateBOM: true,

          canApproveInventory: false,

          canRequestInventory: false,

          canOutAllotInventory: false,

          canStartProduction: false,

          productionProcessId: null,

          productionProcessName: "N/A"

        });

        continue;

      }



      // Find production process for this BOM

      const productionProcess = allProductionProcesses.find(pp =>

        pp._id.toString() === bom.production_process?.toString()

      );



      // Get raw materials for this BOM

      const rawMaterials = allRawMaterials.filter(rm =>

        rm.bom._id.toString() === bom._id.toString()

      );



      // Calculate inventory status

      const totalMaterials = rawMaterials.length;

      const approvedMaterials = rawMaterials.filter(rm => rm.isInventoryApprovalClicked).length;

      const pendingMaterials = totalMaterials - approvedMaterials;



      let inventoryStatus = "Pending";

      if (approvedMaterials === totalMaterials && totalMaterials > 0) {

        inventoryStatus = "Approved";

      } else if (approvedMaterials > 0) {

        inventoryStatus = "Partially Approved";

      } else if (totalMaterials === 0) {

        inventoryStatus = "No Materials";

      }



      // Determine production status

      let productionStatus = "Not Started";

      if (productionProcess) {

        productionStatus = productionProcess.status;

      }



      // Determine overall status

      let overallStatus = "Pending";

      if (inventoryStatus === "Approved" && productionStatus === "inventory allocated") {

        overallStatus = "Ready for Production";

      } else if (productionStatus === "production started") {

        overallStatus = "Production Started";

      } else if (productionStatus === "production in progress") {

        overallStatus = "Production in Progress";

      } else if (productionStatus === "completed") {

        overallStatus = "Completed";

      } else if (inventoryStatus === "Approved") {

        overallStatus = "Inventory Approved";

      } else if (inventoryStatus === "Partially Approved") {

        overallStatus = "Partially Approved";

      }



      // Determine available actions

      const canCreateBOM = false; // BOM already exists

      const canApproveInventory = inventoryStatus !== "Approved" && totalMaterials > 0;

      const canRequestInventory = inventoryStatus === "Approved" && (!productionProcess || productionProcess.status === "raw material approval pending");

      const canOutAllotInventory = productionProcess && productionProcess.status === "request for allow inventory";

      const canStartProduction = productionProcess && productionProcess.status === "inventory in transit";



      const inventoryDetails = rawMaterials.map(rm => ({

        _id: rm._id,

        product_id: rm.item?.product_id,

        name: rm.item?.name,

        inventory_category: rm.item?.inventory_category,

        uom: rm.item?.uom,

        current_stock: rm.item?.current_stock,

        price: rm.item?.price,

        approved: rm.isInventoryApprovalClicked,

        isInventoryApprovalClicked: rm.isInventoryApprovalClicked,

        quantity: rm.quantity,

        description: rm.description,

        comments: rm.comments,

        total_part_cost: rm.total_part_cost,

        in_production: rm.in_production,

        approvedByAdmin: rm.approvedByAdmin,

        approvedByInventoryPersonnel: rm.approvedByInventoryPersonnel

      }));



      const productionDetails = productionProcess ? {

        _id: productionProcess._id,

        process_id: productionProcess.process_id || productionProcess._id,

        process_name: productionProcess.process_name || `Production Process ${productionProcess._id}`,

        status: productionProcess.status,

        quantity: productionProcess.quantity,

        creator: productionProcess.creator,

        item: productionProcess.item,

        rm_store: productionProcess.rm_store,

        fg_store: productionProcess.fg_store,

        scrap_store: productionProcess.scrap_store,

        processes: productionProcess.processes,

        raw_materials: productionProcess.raw_materials,

        scrap_materials: productionProcess.scrap_materials,

        finished_good: productionProcess.finished_good,

        createdAt: productionProcess.createdAt,

        updatedAt: productionProcess.updatedAt

      } : null;



      salesOrdersStatus.push({

        salesOrderId: salesOrder._id,

        salesOrderNumber: salesOrder.order_id || salesOrder._id,

        buyerName: salesOrder.party?.name || "N/A",

        sellerName: "N/A", // Purchase model doesn't have seller

        totalAmount: (salesOrder.price * salesOrder.product_qty) || 0,

        orderDate: salesOrder.createdAt,

        overallStatus,

        bomStatus: bom.approved ? "Approved" : "Pending",

        bomName: bom.bom_name || "N/A",

        bomId: bom.bom_id || "N/A",

        inventoryStatus,

        productionStatus,

        totalMaterials,

        approvedMaterials,

        pendingMaterials,

        inventoryDetails,

        productionDetails,

        canCreateBOM,

        canApproveInventory,

        canRequestInventory,

        canOutAllotInventory,

        canStartProduction,

        bomId: bom._id,

        productionProcessId: productionProcess?._id,

        productionProcessName: productionProcess?.process_name || productionProcess?._id || "N/A",

        bomDetails: {

          _id: bom._id,

          bom_id: bom.bom_id,

          bom_name: bom.bom_name,

          approved: bom.approved,

          is_production_started: bom.is_production_started,

          parts_count: bom.parts_count,

          total_cost: bom.total_cost,

          remarks: bom.remarks,

          creator: bom.creator,

          approved_by: bom.approved_by,

          finished_good: bom.finished_good,

          raw_materials: bom.raw_materials,

          scrap_materials: bom.scrap_materials,

          resources: bom.resources,

          manpower: bom.manpower,

          processes: bom.processes,

          other_charges: bom.other_charges,

          createdAt: bom.createdAt,

          updatedAt: bom.updatedAt

        }

      });

    }



    // Count how many sales orders have BOMs assigned

    const salesOrdersWithBOMs = salesOrdersStatus.filter(status => status.bomStatus !== "Not Created").length;



    console.log(`Sales Orders with BOMs: ${salesOrdersWithBOMs}/${salesOrdersStatus.length}`);



    res.status(200).json({

      status: 200,

      success: true,

      message: "All sales orders status fetched successfully",

      totalSalesOrders: salesOrdersStatus.length,

      totalPreProductionProcesses: allProductionProcesses.length,

      totalBOMs: allBOMs.length,

      totalRawMaterials: allRawMaterials.length,

      salesOrdersWithBOMs,

      salesOrdersStatus

    });



  } catch (error) {

    console.error("Error in getAllSalesOrdersStatus:", error);

    res.status(500).json({

      status: 500,

      success: false,

      message: "Internal server error",

      error: error.message

    });

  }

};



// Export the getAllSalesOrdersStatus function

exports.getAllSalesOrdersStatus = getAllSalesOrdersStatus;



// All functions are already exported using exports.functionName syntax above

exports.bulkRemove = TryCatch(async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    throw new ErrorHandler("No BOM IDs provided for bulk delete", 400);
  }

  // First, find all BOMs to get their related materials
  const bomsToDelete = await BOM.find({ _id: { $in: ids } });

  if (bomsToDelete.length === 0) {
    return res.status(404).json({
      status: 404,
      success: false,
      message: "No BOMs found with the provided IDs",
    });
  }

  // Collect all raw materials, finished goods, and scrap materials IDs for cleanup
  const rawMaterialIds = [];
  const finishedGoodIds = [];
  const scrapMaterialIds = [];

  bomsToDelete.forEach((bom) => {
    // Collect raw materials IDs
    if (bom.raw_materials && bom.raw_materials.length > 0) {
      rawMaterialIds.push(...bom.raw_materials.map((material) => material._id));
    }

    // Collect finished good ID
    if (bom.finished_good) {
      finishedGoodIds.push(bom.finished_good._id);
    }

    // Collect scrap materials IDs
    if (bom.scrap_materials && bom.scrap_materials.length > 0) {
      scrapMaterialIds.push(
        ...bom.scrap_materials.map((material) => material._id)
      );
    }
  });

  // Perform cleanup operations
  await Promise.all([
    // Delete related raw materials
    rawMaterialIds.length > 0
      ? BOMRawMaterial.deleteMany({ _id: { $in: rawMaterialIds } })
      : Promise.resolve(),

    // Delete related finished goods
    finishedGoodIds.length > 0
      ? BOMFinishedMaterial.deleteMany({ _id: { $in: finishedGoodIds } })
      : Promise.resolve(),

    // Delete related scrap materials
    scrapMaterialIds.length > 0
      ? BOMScrapMaterial.deleteMany({ _id: { $in: scrapMaterialIds } })
      : Promise.resolve(),

    // Delete inventory shortages
    InventoryShortage.deleteMany({ bom: { $in: ids } }),
  ]);

  // Finally, delete the BOMs
  const deletedBOMs = await BOM.deleteMany({ _id: { $in: ids } });

  res.status(200).json({
    status: 200,
    success: true,
    message: `${deletedBOMs.deletedCount} BOM(s) deleted successfully`,
  });
});

// Function to recreate shortages for a BOM when it's edited
exports.recreateShortagesForBOM = TryCatch(async (req, res) => {
  const { bomId } = req.params;

  if (!bomId) {
    throw new ErrorHandler("BOM ID is required", 400);
  }

  // Find the BOM with all its raw materials
  const bom = await BOM.findById(bomId)
    .populate({ path: "raw_materials", populate: { path: "item" } });

  if (!bom) {
    throw new ErrorHandler("BOM not found", 400);
  }

  // Get existing shortages for this BOM
  const existingShortages = await InventoryShortage.find({ bom: bomId });
  
  // Create a map of existing shortages by item for quick lookup
  const existingShortagesMap = new Map();
  existingShortages.forEach(shortage => {
    if (shortage.item) {
      existingShortagesMap.set(shortage.item.toString(), shortage);
    }
  });

  // Delete all existing shortages for this BOM
  await InventoryShortage.deleteMany({ bom: bomId });

  const recreatedShortages = [];

  // Process each raw material to check for shortages
  for (const rawMaterial of bom.raw_materials) {
    const product = await Product.findById(rawMaterial.item);
    if (!product) continue;

    // Calculate total available stock
    const totalAvailableStock = (product.current_stock || 0) + (product.updated_stock || 0);
    const quantityDifference = rawMaterial.quantity - totalAvailableStock;

    if (quantityDifference > 0) {
      // Check if there was a previously resolved shortage for this item
      const existingShortage = existingShortagesMap.get(rawMaterial.item.toString());
      
      let originalShortageQuantity = quantityDifference;
      let shouldRecreateOnEdit = true;
      
      // If there was a previously resolved shortage, use its original quantity
      if (existingShortage && existingShortage.is_resolved) {
        originalShortageQuantity = existingShortage.original_shortage_quantity;
        shouldRecreateOnEdit = existingShortage.should_recreate_on_edit;
      }

      const newShortage = await InventoryShortage.create({
        bom: bomId,
        raw_material: rawMaterial._id,
        item: rawMaterial.item,
        shortage_quantity: quantityDifference,
        original_shortage_quantity: originalShortageQuantity,
        is_resolved: false, // Reset to unresolved when BOM is edited
        resolved_at: null,
        resolved_by: null,
        should_recreate_on_edit: shouldRecreateOnEdit,
      });

      recreatedShortages.push(newShortage);
    }
  }

  res.status(200).json({
    status: 200,
    success: true,
    message: "Shortages recreated successfully for BOM",
    bomId: bomId,
    recreatedShortages: recreatedShortages.length,
    shortages: recreatedShortages
  });
});

// Function to get all shortages for a specific BOM
exports.getBOMShortages = TryCatch(async (req, res) => {
  const { bomId } = req.params;

  if (!bomId) {
    throw new ErrorHandler("BOM ID is required", 400);
  }

  const shortages = await InventoryShortage.find({ bom: bomId })
    .populate('item', 'name product_id current_stock updated_stock')
    .populate('raw_material', 'quantity description')
    .populate('resolved_by', 'name email');

  res.status(200).json({
    status: 200,
    success: true,
    message: "BOM shortages fetched successfully",
    bomId: bomId,
    shortages: shortages
  });
});
