// A helper function to construct the detailed Z20838 (float64) object.
function buildFloat64Object(
  positive: boolean,
  exponent: number,
  mantisse: bigint,
  special: string
): any {
  return {
    Z1K1: "Z20838",
    Z20838K1: {
      Z1K1: "Z16659",
      Z16659K1: {
        Z1K1: "Z9",
        Z9K1: positive ? "Z16660" : "Z16662",
      },
    },
    Z20838K2: {
      Z1K1: "Z16683",
      Z16683K1: {
        Z1K1: "Z16659",
        "Z16659K1": {
          Z1K1: "Z9",
          Z9K1: exponent < 0 ? "Z16662" : exponent === 0 ? "Z16661" : "Z16660",
        },
      },
      "Z16683K2": {
        Z1K1: "Z13518",
        "Z13518K1": {
          Z1K1: "Z6",
          "Z6K1": Math.abs(exponent).toString(),
        },
      },
    },
    "Z20838K3": {
      Z1K1: "Z13518",
      "Z13518K1": {
        Z1K1: "Z6",
        "Z6K1": mantisse.toString(),
      },
    },
    "Z20838K4": {
      Z1K1: "Z20825",
      "Z20825K1": {
        Z1K1: "Z9",
        "Z9K1": special,
      },
    },
  };
}

export function convertValueToZObject(value: any, requiredTypeZid: string): any {
  switch (requiredTypeZid) {
    case "Z16683": {
      // Logic to convert a JavaScript number/BigInt to a Wikifunctions Integer (Z16683) object.
      const num = BigInt(value);
      const absValue = num > 0n ? num : -num;

      let signZid;
      if (num > 0n) {
        signZid = "Z16660"; // Positive
      } else if (num < 0n) {
        signZid = "Z16662"; // Negative
      } else {
        signZid = "Z16661"; // Zero
      }

      return {
        Z1K1: "Z16683",
        Z16683K1: {
          Z1K1: "Z16659",
          Z16659K1: {
            Z1K1: "Z9",
            Z9K1: signZid,
          },
        },
        Z16683K2: {
          Z1K1: "Z13518",
          Z13518K1: {
            Z1K1: "Z6",
            Z6K1: absValue.toString(),
          },
        },
      };
    }

    case "Z20838": {
      // Logic to convert a JavaScript number to a Wikifunctions float64 (Z20838) object.
      const num = Number(value);

      if (Number.isNaN(num)) {
        return buildFloat64Object(true, 0, 0n, "Z20834");
      }
      if (num === Number.POSITIVE_INFINITY) {
        return buildFloat64Object(true, 0, 0n, "Z20832");
      }
      if (num === Number.NEGATIVE_INFINITY) {
        return buildFloat64Object(false, 0, 0n, "Z20833");
      }
      if (Object.is(num, -0)) {
        return buildFloat64Object(false, 0, 0n, "Z20831");
      }
      if (num === 0) {
        return buildFloat64Object(true, 0, 0n, "Z20829");
      }

      const positive = num >= 0;
      const absval = positive ? num : -num;

      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setFloat64(0, absval, false);
      const i = view.getBigUint64(0, false);

      const exponent = (i >> 52n) - 1023n;
      const mantisse = i % 2n ** 52n;
      return buildFloat64Object(positive, Number(exponent), mantisse, "Z20837");
    }

    default: {
      // For types that don't have special conversion logic, wrap them as a string-like object.
      const valueKey = `${requiredTypeZid}K1`;
      return {
        Z1K1: requiredTypeZid,
        [valueKey]: String(value),
      };
    }
  }
}

export function convertZObjectToValue(zObject: any): any {
  if (!zObject || typeof zObject.Z1K1 !== "string") {
    return zObject; // Not a valid Z-Object, return as is.
  }

  const type = zObject.Z1K1;

  switch (type) {
    case "Z16683": {
      // Logic to convert a Wikifunctions Integer (Z16683) object to a JavaScript BigInt.
      let valueStr = zObject.Z16683K2?.Z13518K1;
      if (typeof valueStr === "object" && valueStr !== null && valueStr.Z1K1 === "Z6") {
        valueStr = valueStr.Z6K1;
      }

      if (typeof valueStr !== "string") {
        return zObject; // Malformed integer object
      }

      const value = BigInt(valueStr);

      let sign: any = zObject.Z16683K1?.Z16659K1;
      while (typeof sign === "object" && sign !== null) {
        if ("Z9K1" in sign) {
          sign = sign.Z9K1;
        } else if ("Z16659K1" in sign) {
          sign = sign.Z16659K1;
        } else {
          sign = ""; // Break loop
        }
      }

      let signMultiplier: bigint;
      if (sign === "Z16662") {
        signMultiplier = -1n;
      } else if (sign === "Z16661") {
        signMultiplier = 0n;
      } else {
        signMultiplier = 1n;
      }

      if (value > 0n && signMultiplier === 0n) {
        return value;
      }

      return signMultiplier * value;
    }
    
    case "Z20838": {
      // Logic to convert a Wikifunctions float64 (Z20838) object back to a JavaScript number.
      const special = zObject.Z20838K4?.Z20825K1;
      switch (special) {
        case "Z20834":
          return NaN;
        case "Z20832":
          return Number.POSITIVE_INFINITY;
        case "Z20833":
          return Number.NEGATIVE_INFINITY;
        case "Z20831":
          return -0;
        case "Z20829":
          return 0;
      }

      const positive = zObject.Z20838K1?.Z16659K1 === "Z16660";
      const exponentSign = zObject.Z20838K2?.Z16683K1?.Z16659K1;
      const exponentStr = zObject.Z20838K2?.Z16683K2?.Z13518K1;
      const mantisseStr = zObject.Z20838K3?.Z13518K1;

      if (exponentStr === undefined || mantisseStr === undefined) {
        return zObject; // Malformed object
      }

      let exponent = BigInt(exponentStr);
      if (exponentSign === "Z16662") {
        exponent = -exponent;
      }

      const mantisse = BigInt(mantisseStr);

      const i = (exponent + 1023n << 52n) + mantisse;

      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setBigUint64(0, i, false);
      let value = view.getFloat64(0, false);

      if (!positive) {
        value = -value;
      }
      return value;
    }

    // Default case for simple string-like values (Z6, Z13518, etc.)
    default: {
      const valueKey = `${type}K1`;
      if (Object.prototype.hasOwnProperty.call(zObject, valueKey)) {
        return zObject[valueKey];
      }
      return zObject; // Return the full object if the structure is not recognized.
    }
  }
}
