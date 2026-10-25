import { fieldsForScope } from '../../core/rules/contract'
import { EXPR_FUNCTIONS } from '../../core/rules/expr'
import { useI18n } from '../../i18n'

type Field = ReturnType<typeof fieldsForScope>[number]

function FieldList({ title, fields }: { title: string; fields: Field[] }) {
  return (
    <div>
      <h5>{title}</h5>
      <ul>
        {fields.map((field) => (
          <li key={field.name}>
            <b>{field.name}</b>
            <span>
              {field.type} · {field.description}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 写表达式时的速查：两种作用域各有哪些字段，以及可用的函数。 */
export function FieldHelp() {
  const { t } = useI18n()
  const stepFields = fieldsForScope('step')
  const trajectoryFields = fieldsForScope('trajectory')

  return (
    <details className="drawer-help">
      <summary>{t('rules.help')}</summary>
      <div className="field-groups">
        <FieldList title={t('rules.stepScope', { count: stepFields.length })} fields={stepFields} />
        <FieldList
          title={t('rules.trajectoryScope', { count: trajectoryFields.length })}
          fields={trajectoryFields}
        />
        <div>
          <h5>{t('rules.functions')}</h5>
          <ul>
            {EXPR_FUNCTIONS.map((fn) => (
              <li key={fn.name}>
                <b>{fn.signature}</b>
                <span>{fn.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="hint">{t('rules.templateHint')}</p>
    </details>
  )
}
