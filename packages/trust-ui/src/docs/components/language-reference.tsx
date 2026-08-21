import { useTranslation } from "react-i18next";

import { operationLanguage } from "@trust/operation/language";
import { procedureLanguage } from "@trust/procedure/language";

type ReferenceRow = readonly [string, readonly string[]];

export function OperationLanguageReference() {
  const { t } = useTranslation();
  return <ReferenceTable rows={[
    [t("docs.language.roots"), operationLanguage.jsonata.roots],
    [t("docs.language.operators"), operationLanguage.jsonata.binaryOperators],
    [t("docs.language.functions"), operationLanguage.jsonata.functions.map((name) => `$${name}`)],
  ]} />;
}

export function ProcedureLanguageReference() {
  const { t } = useTranslation();
  const qualification = procedureLanguage.qualification;
  return <ReferenceTable rows={[
    [t("docs.language.roots"), Object.values(qualification.roots)],
    [t("docs.language.operators"), Object.values(qualification.operators).flatMap((operators) => Object.keys(operators))],
    [t("docs.language.math"), Object.keys(qualification.mathFunctions).map((name) => `Math.${name}`)],
    [t("docs.language.collections"), Object.keys(qualification.collectionMethods)],
    [t("docs.language.strings"), Object.keys(qualification.stringMethods)],
  ]} />;
}

function ReferenceTable({ rows }: { rows: readonly ReferenceRow[] }) {
  return <div className="docs-table-wrap my-4 overflow-x-auto"><table><tbody>{rows.map(([label, values]) => (
    <tr key={label}><th>{label}</th><td>{values.map((value) => <code key={value} className="mr-2 whitespace-nowrap">{value}</code>)}</td></tr>
  ))}</tbody></table></div>;
}
