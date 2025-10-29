const express = require("express");
const {
  create,
  update,
  getAll,
  getOne,
  AddToken,
  uploadinvoice,
  Delivered,
  Imagehandler,
} = require("../controllers/sales");
const { isAuthenticated } = require("../middlewares/isAuthenticated");
// const { isSuper } = require("../middlewares/isSuper");
const { isAllowed } = require("../middlewares/isAllowed");
const { Imageupload } = require("../utils/upload");
const { Validater } = require("../validation/Validator");
const { SalesValidation } = require("../validation/sales.validation");

const router = express.Router();

// router.route("/").post(isAuthenticated, isAllowed, create).put(isAuthenticated, isAllowed, update).delete(isAuthenticated, isAllowed, remove);
// router.get("/all", isAuthenticated, all);
// router.get("/wip", isAuthenticated, workInProgressProducts);
// router.get("/unapproved", isAuthenticated, isSuper, unapproved);
router.post("/create", isAuthenticated, Validater(SalesValidation), create);

// router.get("/:id", isAuthenticated, isAllowed, details);

router.put("/update/:id", isAuthenticated, update);

router.patch(
  "/upload-image/:id",
  isAuthenticated, // second image  upload
  Imagehandler
);

router.put(
  "/upload-invoice/:id",
  isAuthenticated,
  Imageupload.single("invoice"),
  uploadinvoice
);

router.patch("/addToken/:id", isAuthenticated, AddToken);

router.get("/getAll", isAuthenticated, getAll);
router.get("/getOne", isAuthenticated, getOne);

router.patch("/delivery/:id", Imageupload.single("delivery"), Delivered);
module.exports = router;
//
