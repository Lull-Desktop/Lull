import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LibraryImportActions } from "./library-import-actions";

test("imports a folder or singles through the footer actions", () => {
  const onAddFolder = vi.fn();
  const onAddSingles = vi.fn();
  render(
    <LibraryImportActions
      onAddFolder={onAddFolder}
      onAddSingles={onAddSingles}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "导入目录" }));
  fireEvent.click(screen.getByRole("button", { name: "导入单曲" }));

  expect(onAddFolder).toHaveBeenCalledTimes(1);
  expect(onAddSingles).toHaveBeenCalledTimes(1);
});

test("disables both imports while a picker is running", () => {
  render(
    <LibraryImportActions
      onAddFolder={vi.fn()}
      onAddSingles={vi.fn()}
      disabled
    />,
  );

  expect(
    (screen.getByRole("button", { name: "导入目录" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "导入单曲" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
