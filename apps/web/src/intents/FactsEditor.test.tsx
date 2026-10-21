/**
 * 「読み解いた条件」の行内編集(FactsEditor)の単体試験。
 * 主題の確定・条件の追加と削除・お酒の表示のみ(readOnly)を確かめる
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsEditor } from "./FactsEditor";
import type { FactsValues } from "./submit";

const baseValues: FactsValues = {
	topic: "イラスト仲間",
	startLocal: "",
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	softConstraints: ["初心者歓迎"],
	alcoholInvolved: false,
};

const occasionValues: FactsValues = {
	topic: "軽く飲みに行く",
	startLocal: "2026-10-21T20:00",
	participants: { min: 2, max: 4, includes_owner: true },
	budget: { min: 5000, max: 5000, currency: "JPY" },
	softConstraints: [],
	alcoholInvolved: true,
};

/** 値を親で持つ使い方(Confirmと同じ)。onChangeの呼び出しも観測する */
const Harness = ({
	initial,
	form,
	onChange,
	readOnly,
}: {
	initial: FactsValues;
	form: "connection" | "occasion";
	onChange: (next: FactsValues) => void;
	readOnly?: ReadonlyArray<"alcohol">;
}) => {
	const [values, setValues] = useState(initial);
	return (
		<dl className="facts">
			<FactsEditor
				form={form}
				values={values}
				errors={{}}
				readOnly={readOnly}
				onChange={(next) => {
					onChange(next);
					setValues(next);
				}}
			/>
		</dl>
	);
};

afterEach(() => {
	cleanup();
});

describe("FactsEditor", () => {
	it("主題の鉛筆から入力して確定するとonChangeに新しいtopicが渡る", () => {
		const onChange = vi.fn();
		render(
			<Harness initial={baseValues} form="connection" onChange={onChange} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "主題を直す" }));
		const input = screen.getByRole("textbox", { name: "主題" });
		fireEvent.change(input, { target: { value: "  絵の見せ合い  " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenLastCalledWith({
			...baseValues,
			topic: "絵の見せ合い",
		});
		expect(screen.getByText("絵の見せ合い")).toBeTruthy();
	});

	it("条件の追加と削除がsoftConstraintsに反映される", () => {
		const onChange = vi.fn();
		render(
			<Harness initial={baseValues} form="connection" onChange={onChange} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "条件を足す" }));
		const input = screen.getByRole("textbox", { name: "条件を入力" });
		fireEvent.change(input, { target: { value: "月1くらい" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onChange).toHaveBeenLastCalledWith({
			...baseValues,
			softConstraints: ["初心者歓迎", "月1くらい"],
		});
		fireEvent.click(screen.getByRole("button", { name: "初心者歓迎を外す" }));
		expect(onChange).toHaveBeenLastCalledWith({
			...baseValues,
			softConstraints: ["月1くらい"],
		});
	});

	it("readOnlyにalcoholを含むとお酒のスイッチが無く表示だけになる", () => {
		render(
			<Harness
				initial={occasionValues}
				form="occasion"
				onChange={vi.fn()}
				readOnly={["alcohol"]}
			/>,
		);
		expect(screen.getByText("お酒")).toBeTruthy();
		expect(screen.getByText("含む")).toBeTruthy();
		expect(screen.queryByRole("checkbox", { name: "お酒を含む" })).toBeNull();
	});

	it("readOnlyを指定しなければお酒のスイッチでalcoholInvolvedが変わる", () => {
		const onChange = vi.fn();
		render(
			<Harness initial={occasionValues} form="occasion" onChange={onChange} />,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: "お酒を含む" }));
		expect(onChange).toHaveBeenLastCalledWith({
			...occasionValues,
			alcoholInvolved: false,
		});
	});

	it("errorsの文言を該当の行に出す", () => {
		render(
			<dl className="facts">
				<FactsEditor
					form="occasion"
					values={{ ...occasionValues, topic: "", startLocal: "" }}
					errors={{
						topic: "主題を入力してください",
						start: "日時を入力してください",
					}}
					onChange={vi.fn()}
				/>
			</dl>,
		);
		expect(screen.getByText("主題を入力してください")).toBeTruthy();
		expect(screen.getByText("日時を入力してください")).toBeTruthy();
	});
});
