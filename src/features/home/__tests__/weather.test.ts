import { describe, expect, it } from "vitest";
import { cityFromTimeZone, describe as describeWeather } from "../weather";

describe("cityFromTimeZone", () => {
  it("turns a zone into a city name", () => {
    expect(cityFromTimeZone("America/Los_Angeles")).toBe("Los Angeles");
    expect(cityFromTimeZone("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(cityFromTimeZone("Asia/Jakarta")).toBe("Jakarta");
  });

  it("gives up on zones that aren't a place", () => {
    expect(cityFromTimeZone("UTC")).toBeNull();
    expect(cityFromTimeZone("Etc/GMT+8")).toBeNull();
  });
});

describe("weather codes", () => {
  it("folds WMO codes into a few words", () => {
    expect(describeWeather(0, true).label).toBe("Clear");
    expect(describeWeather(2, false).label).toBe("Partly cloudy");
    expect(describeWeather(63, true).label).toBe("Rain");
    expect(describeWeather(81, true).label).toBe("Rain");
    expect(describeWeather(73, true).label).toBe("Snow");
    expect(describeWeather(95, true).label).toBe("Storms");
  });
});
